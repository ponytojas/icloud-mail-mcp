import Imap from 'imap';
import { MailParser, type AddressObject, type Headers } from 'mailparser';
import nodemailer from 'nodemailer';
import { PassThrough } from 'node:stream';
import { configSchema } from '../schemas.js';
import type {
  Attachment,
  EmailMessage,
  iCloudConfig,
  OrganizationRule,
  SearchOptions,
  SendEmailOptions,
} from '../types/config.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024;
const ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

interface ImapBox {
  attribs: string[];
  delimiter: string;
  children?: ImapBoxes;
}

interface ImapBoxes {
  [boxName: string]: ImapBox;
}

export interface MailboxInfo {
  name: string;
  attributes: string[];
  delimiter: string;
  children?: MailboxInfo[];
}

interface ImapMessageAttributes {
  uid?: number;
  flags?: string[];
  date?: Date;
  struct?: unknown[];
}

interface ImapMessage {
  on(event: 'body', listener: (stream: NodeJS.ReadableStream) => void): this;
  once(
    event: 'attributes',
    listener: (attrs: ImapMessageAttributes) => void
  ): this;
  once(event: 'end', listener: () => void): this;
}

interface MimePart {
  partID?: string;
  type?: string;
  subtype?: string;
  encoding?: string;
  size?: number;
  params?: Record<string, string>;
  disposition?: {
    type?: string;
    params?: Record<string, string>;
  };
}

export interface OperationResult {
  status: 'success';
  message: string;
}

export interface AttachmentResult extends OperationResult {
  attachment: {
    filename: string;
    contentType: string;
    size: number;
    data: string;
  };
}

export interface OrganizationResult {
  status: 'success' | 'partial';
  message: string;
  results: Array<{
    rule: string;
    matchedMessages: number;
    moved: boolean;
    error?: string;
    messages?: Array<{
      id: string;
      from: string;
      subject: string;
      destinationMailbox: string;
    }>;
  }>;
}

export interface MailClientOptions {
  operationTimeoutMs?: number;
  bodyLimitBytes?: number;
  attachmentLimitBytes?: number;
}

export class iCloudMailClient {
  private imap: Imap;
  private readonly transporter: nodemailer.Transporter;
  private readonly config: Required<iCloudConfig>;
  private readonly operationTimeoutMs: number;
  private readonly bodyLimitBytes: number;
  private readonly attachmentLimitBytes: number;
  private isConnected = false;
  private connectionPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private connectionInvalidated = false;
  private imapUser: string;

  constructor(config: iCloudConfig, options: MailClientOptions = {}) {
    this.config = configSchema.parse(config);
    this.operationTimeoutMs =
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    this.attachmentLimitBytes =
      options.attachmentLimitBytes ?? ATTACHMENT_LIMIT_BYTES;
    this.imapUser = this.extractEmailName(this.config.email);
    this.imap = this.createImap(this.imapUser);
    this.transporter = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: false,
      requireTLS: true,
      auth: { user: this.config.email, pass: this.config.appPassword },
      tls: { rejectUnauthorized: true },
    });
  }

  private extractEmailName(email: string): string {
    return email.slice(0, email.indexOf('@'));
  }

  private createImap(user: string): Imap {
    const imap = new Imap({
      user,
      password: this.config.appPassword,
      host: this.config.imapHost,
      port: this.config.imapPort,
      tls: true,
      tlsOptions: {
        servername: this.config.imapHost,
        rejectUnauthorized: true,
      },
      authTimeout: this.operationTimeoutMs,
      connTimeout: this.operationTimeoutMs,
    });

    imap.on('error', (error: Error) => {
      if (this.imap !== imap) return;
      if (this.isConnected) console.error('IMAP connection error:', error);
      this.isConnected = false;
      this.connectionInvalidated = true;
    });
    imap.on('close', () => {
      if (this.imap !== imap) return;
      this.isConnected = false;
      this.connectionInvalidated = true;
    });
    imap.on('end', () => {
      if (this.imap !== imap) return;
      this.isConnected = false;
      this.connectionInvalidated = true;
    });
    return imap;
  }

  private isAuthenticationError(error: Error): boolean {
    return /authenticat|invalid credentials|login failed/iu.test(error.message);
  }

  private connectAttempt(imap: Imap): Promise<void> {
    return this.withTimeout(
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const succeed = () => {
          if (settled) return;
          settled = true;
          this.isConnected = true;
          this.connectionInvalidated = false;
          resolve();
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          this.isConnected = false;
          reject(error);
        };
        imap.once('ready', succeed);
        imap.once('error', fail);
        imap.connect();
      }),
      'IMAP connection'
    );
  }

  async connect(): Promise<void> {
    if (this.shuttingDown) throw new Error('Mail client is shutting down');
    if (this.isConnected) return;
    if (this.connectionPromise) return this.connectionPromise;
    if (this.connectionInvalidated) {
      this.imap.destroy();
      this.imap = this.createImap(this.imapUser);
      this.connectionInvalidated = false;
    }

    const connection = (async () => {
      try {
        await this.connectAttempt(this.imap);
      } catch (error) {
        const initialError =
          error instanceof Error ? error : new Error(String(error));
        const shortUser = this.extractEmailName(this.config.email);
        if (
          !this.isAuthenticationError(initialError) ||
          shortUser === this.config.email
        ) {
          throw new Error(`IMAP connection failed: ${initialError.message}`);
        }

        this.imap.destroy();
        this.imapUser = this.config.email;
        this.imap = this.createImap(this.config.email);
        try {
          await this.connectAttempt(this.imap);
        } catch (retryError) {
          const detail =
            retryError instanceof Error
              ? retryError.message
              : String(retryError);
          throw new Error(
            `IMAP authentication failed. Check the app-specific password and two-factor authentication. Details: ${detail}`
          );
        }
      }
    })();

    this.connectionPromise = connection;
    try {
      await connection;
    } finally {
      this.connectionPromise = null;
    }
  }

  private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.isConnected = false;
        this.imap.destroy();
        reject(
          new Error(
            `${operation} timed out after ${this.operationTimeoutMs} milliseconds`
          )
        );
      }, this.operationTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  private runSerialized<T>(
    operation: string,
    action: () => Promise<T>
  ): Promise<T> {
    const run = this.operationQueue.then(async () => {
      await this.connect();
      return this.withTimeout(action(), operation);
    });
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    await this.operationQueue;
    if (!this.isConnected) {
      this.imap.destroy();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000);
      this.imap.once('end', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.imap.end();
    });
    this.isConnected = false;
  }

  async testConnection(): Promise<OperationResult> {
    await this.connect();
    await this.withTimeout(this.transporter.verify(), 'SMTP verification');
    return {
      status: 'success',
      message:
        'Email connection test successful - both IMAP and SMTP are working',
    };
  }

  private getBoxesRaw(): Promise<ImapBoxes> {
    return new Promise((resolve, reject) => {
      this.imap.getBoxes((error: Error, boxes: ImapBoxes) => {
        if (error) reject(error);
        else resolve(boxes);
      });
    });
  }

  private serializeMailboxes(boxes: ImapBoxes): MailboxInfo[] {
    return Object.entries(boxes).map(([name, box]) => ({
      name,
      attributes: box.attribs ?? [],
      delimiter: box.delimiter,
      children: box.children
        ? this.serializeMailboxes(box.children)
        : undefined,
    }));
  }

  async getMailboxes(): Promise<MailboxInfo[]> {
    return this.runSerialized('List mailboxes', async () =>
      this.serializeMailboxes(await this.getBoxesRaw())
    );
  }

  private normalizeMessageIds(messageIds: string[]): number[] {
    const ids = [...new Set(messageIds.map(Number))];
    if (
      ids.length === 0 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new Error(
        'Message IDs must be positive IMAP UIDs returned by get_messages or search_messages'
      );
    }
    return ids;
  }

  private headerText(headers: Headers, name: string): string {
    const value = headers.get(name);
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (value instanceof Date) return value.toISOString();
    if ('text' in value) return (value as AddressObject).text;
    return '';
  }

  private truncateBody(body: string): { body: string; truncated: boolean } {
    const bytes = Buffer.from(body);
    if (bytes.length <= this.bodyLimitBytes) {
      return { body, truncated: false };
    }
    return {
      body: bytes.subarray(0, this.bodyLimitBytes).toString('utf8'),
      truncated: true,
    };
  }

  private parseMessageStream(
    stream: NodeJS.ReadableStream,
    getAttributes: () => ImapMessageAttributes,
    fallbackUid: number
  ): Promise<EmailMessage> {
    return new Promise((resolve, reject) => {
      const parser = new MailParser({
        skipHtmlToText: true,
        skipTextToHtml: true,
        maxHtmlLengthToParse: this.bodyLimitBytes,
      });
      let headers = new Map() as Headers;
      let body = '';
      const attachmentPromises: Promise<void>[] = [];
      const attachments: Attachment[] = [];

      parser.once('headers', (value: Headers) => {
        headers = value;
      });
      parser.on('data', (part) => {
        if (part.type === 'text') {
          body = part.text || (typeof part.html === 'string' ? part.html : '');
          return;
        }

        const index = attachments.length;
        const attachment = {
          index,
          filename: part.filename || 'unknown',
          contentType: part.contentType || 'application/octet-stream',
          size: part.size || 0,
        };
        attachments.push(attachment);
        attachmentPromises.push(
          new Promise<void>((resolveAttachment, rejectAttachment) => {
            let size = 0;
            part.content.on('data', (chunk: Buffer | string) => {
              size += Buffer.byteLength(chunk);
            });
            part.content.once('error', rejectAttachment);
            part.content.once('end', () => {
              attachment.size = size;
              part.release();
              resolveAttachment();
            });
          })
        );
      });
      parser.once('error', reject);
      stream.once('error', (error) => {
        parser.destroy();
        reject(error);
      });
      parser.once('end', () => {
        void Promise.all(attachmentPromises).then(() => {
          const attributes = getAttributes();
          const truncated = this.truncateBody(body);
          const dateHeader = headers.get('date');
          resolve({
            id: String(attributes.uid ?? fallbackUid),
            from: this.headerText(headers, 'from'),
            to: this.headerText(headers, 'to')
              .split(',')
              .map((address) => address.trim())
              .filter(Boolean),
            subject: this.headerText(headers, 'subject'),
            body: truncated.body,
            bodyTruncated: truncated.truncated,
            date:
              dateHeader instanceof Date
                ? dateHeader
                : (attributes.date ?? new Date(0)),
            flags: attributes.flags ?? [],
            attachments: attachments.length > 0 ? attachments : undefined,
          });
        }, reject);
      });
      stream.pipe(parser);
    });
  }

  private fetchMessages(messageIds: number[]): Promise<EmailMessage[]> {
    return new Promise((resolve, reject) => {
      const fetch = this.imap.fetch(messageIds, { bodies: '', struct: true });
      const messages: Promise<EmailMessage>[] = [];

      fetch.on('message', (message: ImapMessage, sequenceNumber: number) => {
        let attributes: ImapMessageAttributes = {};
        let parsing: Promise<EmailMessage> | undefined;
        message.once('attributes', (value) => {
          attributes = value;
        });
        message.on('body', (stream) => {
          parsing = this.parseMessageStream(
            stream,
            () => attributes,
            sequenceNumber
          );
        });
        messages.push(
          new Promise<EmailMessage>((resolveMessage, rejectMessage) => {
            message.once('end', () => {
              if (!parsing) {
                rejectMessage(
                  new Error('IMAP message contained no body stream')
                );
                return;
              }
              parsing.then(resolveMessage, rejectMessage);
            });
          })
        );
      });
      fetch.once('error', reject);
      fetch.once('end', () => {
        void Promise.all(messages).then((values) => {
          const order = new Map(messageIds.map((uid, index) => [uid, index]));
          values.sort(
            (left, right) =>
              (order.get(Number(left.id)) ?? 0) -
              (order.get(Number(right.id)) ?? 0)
          );
          resolve(values);
        }, reject);
      });
    });
  }

  private openBox(name: string, readOnly: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.openBox(name, readOnly, (error: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private search(criteria: unknown[]): Promise<number[]> {
    return new Promise((resolve, reject) => {
      this.imap.search(criteria, (error: Error, results: number[]) => {
        if (error) reject(error);
        else resolve(results ?? []);
      });
    });
  }

  async getMessages(
    mailbox = 'INBOX',
    limit = 10,
    unreadOnly = false
  ): Promise<EmailMessage[]> {
    return this.runSerialized('Get messages', async () => {
      await this.openBox(mailbox, true);
      const results = await this.search(unreadOnly ? ['UNSEEN'] : ['ALL']);
      if (results.length === 0) return [];
      return this.fetchMessages(results.slice(-limit).reverse());
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    const info = await this.withTimeout(
      this.transporter.sendMail({
        from: this.config.email,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
        attachments: options.attachments,
      }),
      'Send email'
    );
    return { messageId: info.messageId };
  }

  async markAsRead(messageIds: string[], mailbox = 'INBOX'): Promise<void> {
    return this.runSerialized('Mark messages as read', async () => {
      await this.openBox(mailbox, false);
      await new Promise<void>((resolve, reject) => {
        this.imap.addFlags(
          this.normalizeMessageIds(messageIds),
          ['\\Seen'],
          (error: Error) => (error ? reject(error) : resolve())
        );
      });
    });
  }

  async createMailbox(name: string): Promise<OperationResult> {
    return this.runSerialized(
      'Create mailbox',
      () =>
        new Promise((resolve, reject) => {
          this.imap.addBox(name, (error: Error) => {
            if (error) reject(error);
            else
              resolve({
                status: 'success',
                message: `Mailbox '${name}' created successfully`,
              });
          });
        })
    );
  }

  private flattenMailboxes(
    boxes: ImapBoxes,
    parent = ''
  ): Array<{ name: string; attributes: string[] }> {
    const result: Array<{ name: string; attributes: string[] }> = [];
    for (const [leaf, box] of Object.entries(boxes)) {
      const name = parent ? `${parent}${box.delimiter}${leaf}` : leaf;
      result.push({ name, attributes: box.attribs ?? [] });
      if (box.children)
        result.push(...this.flattenMailboxes(box.children, name));
    }
    return result;
  }

  async deleteMailbox(name: string): Promise<OperationResult> {
    return this.runSerialized('Delete mailbox', async () => {
      const boxes = this.flattenMailboxes(await this.getBoxesRaw());
      const mailbox = boxes.find((box) => box.name === name);
      if (!mailbox) throw new Error(`Mailbox '${name}' does not exist`);
      const protectedAttributes = new Set([
        '\\inbox',
        '\\sent',
        '\\trash',
        '\\drafts',
        '\\junk',
        '\\all',
        '\\archive',
        '\\flagged',
        '\\important',
        '\\noselect',
      ]);
      const isProtected =
        name.toUpperCase() === 'INBOX' ||
        mailbox.attributes.some((attribute) =>
          protectedAttributes.has(attribute.toLowerCase())
        );
      if (isProtected)
        throw new Error(`Cannot delete system mailbox '${name}'`);

      await new Promise<void>((resolve, reject) => {
        this.imap.delBox(name, (error: Error) =>
          error ? reject(error) : resolve()
        );
      });
      return {
        status: 'success',
        message: `Mailbox '${name}' deleted successfully`,
      };
    });
  }

  async moveMessages(
    messageIds: string[],
    sourceMailbox: string,
    destinationMailbox: string
  ): Promise<OperationResult> {
    return this.runSerialized('Move messages', async () => {
      await this.openBox(sourceMailbox, false);
      const ids = this.normalizeMessageIds(messageIds);
      await new Promise<void>((resolve, reject) => {
        this.imap.move(ids, destinationMailbox, (error: Error) =>
          error ? reject(error) : resolve()
        );
      });
      return {
        status: 'success',
        message: `Successfully moved ${ids.length} messages from '${sourceMailbox}' to '${destinationMailbox}'`,
      };
    });
  }

  private parseSearchDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  async searchMessages(options: SearchOptions): Promise<EmailMessage[]> {
    const {
      query,
      mailbox = 'INBOX',
      limit = 10,
      dateFrom,
      dateTo,
      fromEmail,
      unreadOnly = false,
    } = options;
    return this.runSerialized('Search messages', async () => {
      await this.openBox(mailbox, true);
      const criteria: unknown[] = [];
      if (unreadOnly) criteria.push('UNSEEN');
      if (dateFrom) criteria.push(['SINCE', this.parseSearchDate(dateFrom)]);
      if (dateTo) {
        const exclusiveEnd = this.parseSearchDate(dateTo);
        exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
        criteria.push(['BEFORE', exclusiveEnd]);
      }
      if (fromEmail) criteria.push(['FROM', fromEmail]);
      if (query) criteria.push(['OR', ['SUBJECT', query], ['BODY', query]]);
      const results = await this.search(
        criteria.length > 0 ? criteria : ['ALL']
      );
      if (results.length === 0) return [];
      return this.fetchMessages(results.slice(-limit).reverse());
    });
  }

  async deleteMessages(
    messageIds: string[],
    mailbox = 'INBOX'
  ): Promise<OperationResult> {
    return this.runSerialized('Delete messages', async () => {
      await this.openBox(mailbox, false);
      const ids = this.normalizeMessageIds(messageIds);
      await new Promise<void>((resolve, reject) => {
        this.imap.addFlags(ids, ['\\Deleted'], (error: Error) =>
          error ? reject(error) : resolve()
        );
      });
      await new Promise<void>((resolve, reject) => {
        this.imap.expunge(ids, (error: Error) =>
          error ? reject(error) : resolve()
        );
      });
      return {
        status: 'success',
        message: `Successfully deleted ${ids.length} messages from '${mailbox}'`,
      };
    });
  }

  async setFlags(
    messageIds: string[],
    flags: string[],
    mailbox = 'INBOX',
    action: 'add' | 'remove' = 'add'
  ): Promise<OperationResult> {
    return this.runSerialized('Set message flags', async () => {
      await this.openBox(mailbox, false);
      const ids = this.normalizeMessageIds(messageIds);
      await new Promise<void>((resolve, reject) => {
        const callback = (error: Error) => (error ? reject(error) : resolve());
        if (action === 'add') this.imap.addFlags(ids, flags, callback);
        else this.imap.delFlags(ids, flags, callback);
      });
      return {
        status: 'success',
        message: `Successfully ${action === 'add' ? 'added' : 'removed'} flags [${flags.join(', ')}] ${action === 'add' ? 'to' : 'from'} ${ids.length} messages in '${mailbox}'`,
      };
    });
  }

  private findAttachmentParts(structure: unknown): MimePart[] {
    const parts: MimePart[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const part = value as MimePart;
      const filename = part.disposition?.params?.filename ?? part.params?.name;
      const disposition = part.disposition?.type?.toLowerCase();
      if (part.partID && (filename || disposition === 'attachment'))
        parts.push(part);
    };
    visit(structure);
    return parts;
  }

  private fetchStructure(uid: number): Promise<MimePart[]> {
    return new Promise((resolve, reject) => {
      const fetch = this.imap.fetch([uid], {
        bodies: 'HEADER.FIELDS (SUBJECT)',
        struct: true,
      });
      let found = false;
      let parts: MimePart[] = [];
      fetch.on('message', (message: ImapMessage) => {
        found = true;
        message.on('body', (stream) => stream.resume());
        message.once('attributes', (attributes) => {
          parts = this.findAttachmentParts(attributes.struct);
        });
      });
      fetch.once('error', reject);
      fetch.once('end', () => {
        if (!found) reject(new Error(`Message with UID '${uid}' not found`));
        else resolve(parts);
      });
    });
  }

  private decodeAttachmentPart(
    uid: number,
    part: MimePart,
    index: number
  ): Promise<AttachmentResult> {
    return new Promise((resolve, reject) => {
      const fetch = this.imap.fetch([uid], { bodies: part.partID ?? '' });
      let found = false;
      let decoding: Promise<AttachmentResult> | undefined;
      fetch.on('message', (message: ImapMessage) => {
        found = true;
        message.on('body', (stream) => {
          decoding = new Promise<AttachmentResult>(
            (resolveAttachment, rejectAttachment) => {
              const parser = new MailParser();
              const sink = new PassThrough();
              const filename =
                part.disposition?.params?.filename ??
                part.params?.name ??
                `attachment-${index}`;
              const contentType =
                `${part.type ?? 'application'}/${part.subtype ?? 'octet-stream'}`.toLowerCase();
              const chunks: Buffer[] = [];
              let size = 0;
              let emitted = false;

              parser.on('data', (data) => {
                if (data.type !== 'attachment') return;
                emitted = true;
                data.content.on('data', (chunk: Buffer | string) => {
                  const buffer = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk);
                  size += buffer.length;
                  if (size <= this.attachmentLimitBytes) chunks.push(buffer);
                });
                data.content.once('error', rejectAttachment);
                data.content.once('end', () => {
                  data.release();
                  if (size > this.attachmentLimitBytes) {
                    rejectAttachment(
                      new Error('Attachment exceeds the 10 MiB download limit')
                    );
                    return;
                  }
                  resolveAttachment({
                    status: 'success',
                    message: `Successfully downloaded attachment '${filename}'`,
                    attachment: {
                      filename,
                      contentType,
                      size,
                      data: Buffer.concat(chunks).toString('base64'),
                    },
                  });
                });
              });
              parser.once('error', rejectAttachment);
              parser.once('end', () => {
                if (!emitted)
                  rejectAttachment(new Error('Unable to decode attachment'));
              });
              sink.pipe(parser);
              const safeFilename = filename.replace(/["\r\n]/gu, '_');
              sink.write(
                `Content-Type: ${contentType}; name="${safeFilename}"\r\nContent-Disposition: attachment; filename="${safeFilename}"\r\nContent-Transfer-Encoding: ${part.encoding ?? '7bit'}\r\n\r\n`
              );
              stream.on('data', (chunk) => sink.write(chunk));
              stream.once('error', rejectAttachment);
              stream.once('end', () => sink.end());
            }
          );
        });
      });
      fetch.once('error', reject);
      fetch.once('end', () => {
        if (!found || !decoding) {
          reject(new Error(`Message with UID '${uid}' not found`));
          return;
        }
        decoding.then(resolve, reject);
      });
    });
  }

  async downloadAttachment(
    messageId: string,
    attachmentIndex = 0,
    mailbox = 'INBOX'
  ): Promise<AttachmentResult> {
    return this.runSerialized('Download attachment', async () => {
      await this.openBox(mailbox, true);
      const uid = this.normalizeMessageIds([messageId])[0];
      const parts = await this.fetchStructure(uid);
      if (parts.length === 0)
        throw new Error('No attachments found in the message');
      if (attachmentIndex >= parts.length) {
        throw new Error(
          `Attachment index ${attachmentIndex} out of range. Message has ${parts.length} attachments`
        );
      }
      const part = parts[attachmentIndex];
      if ((part.size ?? 0) > this.attachmentLimitBytes) {
        throw new Error('Attachment exceeds the 10 MiB download limit');
      }
      return this.decodeAttachmentPart(uid, part, attachmentIndex);
    });
  }

  async autoOrganize(
    rules: OrganizationRule[],
    sourceMailbox = 'INBOX',
    dryRun = true
  ): Promise<OrganizationResult> {
    const [messages, mailboxes] = await Promise.all([
      this.getMessages(sourceMailbox, 100),
      this.getMailboxes(),
    ]);
    const available = new Set<string>();
    const collect = (items: MailboxInfo[], parent = '') => {
      for (const item of items) {
        const name = parent
          ? `${parent}${item.delimiter}${item.name}`
          : item.name;
        available.add(name);
        if (item.children) collect(item.children, name);
      }
    };
    collect(mailboxes);
    for (const rule of rules) {
      if (!available.has(rule.action.moveToMailbox)) {
        throw new Error(
          `Destination mailbox '${rule.action.moveToMailbox}' for rule '${rule.name}' does not exist`
        );
      }
    }

    const assignments = rules.map(() => [] as typeof messages);
    for (const message of messages) {
      const ruleIndex = rules.findIndex((candidate) => {
        const fromMatches = candidate.condition.fromContains
          ? message.from
              .toLowerCase()
              .includes(candidate.condition.fromContains.toLowerCase())
          : false;
        const subjectMatches = candidate.condition.subjectContains
          ? message.subject
              .toLowerCase()
              .includes(candidate.condition.subjectContains.toLowerCase())
          : false;
        return fromMatches || subjectMatches;
      });
      if (ruleIndex >= 0) assignments[ruleIndex].push(message);
    }

    let failures = 0;
    const results: OrganizationResult['results'] = [];
    for (const [ruleIndex, rule] of rules.entries()) {
      const matched = assignments[ruleIndex];
      const summaries = matched.map((message) => ({
        id: message.id,
        from: message.from,
        subject: message.subject,
        destinationMailbox: rule.action.moveToMailbox,
      }));
      let moved = false;
      let error: string | undefined;
      if (!dryRun && matched.length > 0) {
        try {
          await this.moveMessages(
            matched.map((message) => message.id),
            sourceMailbox,
            rule.action.moveToMailbox
          );
          moved = true;
        } catch (moveError) {
          failures += 1;
          error =
            moveError instanceof Error ? moveError.message : String(moveError);
        }
      }
      results.push({
        rule: rule.name,
        matchedMessages: matched.length,
        moved,
        ...(error ? { error } : {}),
        ...(summaries.length > 0 ? { messages: summaries } : {}),
      });
    }

    const totalMatched = results.reduce(
      (sum, result) => sum + result.matchedMessages,
      0
    );
    return {
      status: failures > 0 ? 'partial' : 'success',
      message: dryRun
        ? `Dry run completed. Found ${totalMatched} messages matching organization rules`
        : failures > 0
          ? `Organization completed with ${failures} failed rule operation(s). Processed ${totalMatched} messages`
          : `Organization completed. Processed ${totalMatched} messages`,
      results,
    };
  }
}
