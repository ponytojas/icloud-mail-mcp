import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Imap from 'imap';
import { iCloudMailClient } from './icloud-mail-client.js';
import type { iCloudConfig } from '../types/config.js';

const imapState = vi.hoisted(() => ({
  instances: [] as MockImap[],
  connectMode: 'ready' as 'ready' | 'auth-error' | 'network-error' | 'manual',
}));

class MockFetch extends EventEmitter {}
class MockMessage extends EventEmitter {}

class MockImap extends EventEmitter {
  config: Record<string, unknown>;
  connect = vi.fn(() => {
    queueMicrotask(() => {
      if (imapState.connectMode === 'ready') this.emit('ready');
      if (imapState.connectMode === 'auth-error')
        this.emit('error', new Error('Invalid credentials'));
      if (imapState.connectMode === 'network-error')
        this.emit('error', new Error('ECONNRESET'));
    });
  });
  end = vi.fn(() => queueMicrotask(() => this.emit('end')));
  destroy = vi.fn();
  getBoxes = vi.fn((callback: (error: Error | null, boxes: unknown) => void) =>
    callback(null, {
      INBOX: { attribs: ['\\Inbox'], delimiter: '/', children: undefined },
      Archive: { attribs: [], delimiter: '/', children: undefined },
    })
  );
  openBox = vi.fn(
    (
      _mailbox: string,
      _readOnly: boolean,
      callback: (error: Error | null) => void
    ) => callback(null)
  );
  search = vi.fn(
    (
      _criteria: unknown[],
      callback: (error: Error | null, ids: number[]) => void
    ) => callback(null, [])
  );
  fetch = vi.fn(() => new MockFetch());
  move = vi.fn(
    (
      _ids: number[],
      _destination: string,
      callback: (error: Error | null) => void
    ) => callback(null)
  );
  addFlags = vi.fn(
    (
      _ids: number[],
      _flags: string[],
      callback: (error: Error | null) => void
    ) => callback(null)
  );
  delFlags = vi.fn(
    (
      _ids: number[],
      _flags: string[],
      callback: (error: Error | null) => void
    ) => callback(null)
  );
  expunge = vi.fn((_ids: number[], callback: (error: Error | null) => void) =>
    callback(null)
  );
  addBox = vi.fn((_name: string, callback: (error: Error | null) => void) =>
    callback(null)
  );
  delBox = vi.fn((_name: string, callback: (error: Error | null) => void) =>
    callback(null)
  );

  constructor(config: Record<string, unknown>) {
    super();
    this.config = config;
    imapState.instances.push(this);
  }
}

vi.mock('imap', () => ({
  default: vi.fn().mockImplementation((config) => new MockImap(config)),
}));

const transporter = {
  verify: vi.fn().mockResolvedValue(true),
  sendMail: vi.fn().mockResolvedValue({ messageId: 'sent-id' }),
};

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => transporter) },
}));

const config: iCloudConfig = {
  email: 'test@icloud.com',
  appPassword: 'test-password',
};

function emitMessageFetch(
  imap: MockImap,
  rawMessages: Array<{ uid: number; source: string; flags?: string[] }>
) {
  imap.fetch.mockImplementationOnce(() => {
    const fetch = new MockFetch();
    queueMicrotask(() => {
      for (const raw of rawMessages) {
        const message = new MockMessage();
        fetch.emit('message', message, raw.uid);
        message.emit('body', Readable.from([raw.source]));
        message.emit('attributes', { uid: raw.uid, flags: raw.flags ?? [] });
        message.emit('end');
      }
      fetch.emit('end');
    });
    return fetch;
  });
}

describe('iCloudMailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imapState.instances.length = 0;
    imapState.connectMode = 'ready';
  });

  afterEach(() => vi.useRealTimers());

  it('validates configuration and creates TLS-verified transports', () => {
    const client = new iCloudMailClient(config);
    expect(client).toBeInstanceOf(iCloudMailClient);
    expect(Imap).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'test',
        host: 'imap.mail.me.com',
        port: 993,
        tls: true,
        tlsOptions: expect.objectContaining({ rejectUnauthorized: true }),
      })
    );
    expect(
      () => new iCloudMailClient({ email: 'not-email', appPassword: '' })
    ).toThrow();
  });

  it('falls back to the full address only for initial authentication errors', async () => {
    imapState.connectMode = 'manual';
    const client = new iCloudMailClient(config);
    const first = imapState.instances[0];
    const connecting = client.connect();
    first.emit('error', new Error('Invalid credentials'));
    await vi.waitFor(() => expect(imapState.instances).toHaveLength(2));
    const second = imapState.instances[1];
    expect(second.config.user).toBe('test@icloud.com');
    second.emit('ready');
    await connecting;

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    second.emit('error', new Error('Invalid credentials later'));
    expect(imapState.instances).toHaveLength(2);
    errorLog.mockRestore();
  });

  it('does not retry a non-authentication connection failure', async () => {
    imapState.connectMode = 'network-error';
    const client = new iCloudMailClient(config);
    await expect(client.connect()).rejects.toThrow('ECONNRESET');
    expect(imapState.instances).toHaveLength(1);
  });

  it('reconnects after a dropped session before the next operation', async () => {
    const client = new iCloudMailClient(config);
    await client.connect();
    const imap = imapState.instances[0];
    imap.emit('close');
    await client.getMailboxes();
    expect(imapState.instances).toHaveLength(2);
    expect(imapState.instances[1].connect).toHaveBeenCalledOnce();
  });

  it('serializes mailbox selection across concurrent operations', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    let releaseFirst: (() => void) | undefined;
    imap.openBox
      .mockImplementationOnce(
        (
          _mailbox: string,
          _readOnly: boolean,
          callback: (error: null) => void
        ) => {
          releaseFirst = () => callback(null);
        }
      )
      .mockImplementationOnce(
        (
          _mailbox: string,
          _readOnly: boolean,
          callback: (error: null) => void
        ) => callback(null)
      );
    const first = client.getMessages('INBOX');
    const second = client.getMessages('Archive');
    await vi.waitFor(() => expect(imap.openBox).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(imap.openBox.mock.calls.map((call) => call[0])).toEqual([
      'INBOX',
      'Archive',
    ]);
  });

  it('targets only supplied numeric UIDs for mutations', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    await client.markAsRead(['42', '43', '42']);
    await client.moveMessages(['44'], 'INBOX', 'Archive');
    await client.deleteMessages(['45'], 'INBOX');
    await client.setFlags(['46'], ['\\Flagged'], 'INBOX', 'remove');
    expect(imap.addFlags).toHaveBeenNthCalledWith(
      1,
      [42, 43],
      ['\\Seen'],
      expect.any(Function)
    );
    expect(imap.move).toHaveBeenCalledWith(
      [44],
      'Archive',
      expect.any(Function)
    );
    expect(imap.expunge).toHaveBeenCalledWith([45], expect.any(Function));
    expect(imap.delFlags).toHaveBeenCalledWith(
      [46],
      ['\\Flagged'],
      expect.any(Function)
    );
    expect(imap.search).not.toHaveBeenCalled();
  });

  it('uses mailbox attributes to protect localized system folders', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    imap.getBoxes.mockImplementationOnce((callback) =>
      callback(null, {
        Papelera: {
          attribs: ['\\Trash'],
          delimiter: '/',
          children: undefined,
        },
      })
    );
    await expect(client.deleteMailbox('Papelera')).rejects.toThrow(
      "Cannot delete system mailbox 'Papelera'"
    );
    expect(imap.delBox).not.toHaveBeenCalled();
  });

  it('lists, creates, deletes, sends, verifies, and disconnects cleanly', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    expect(await client.getMailboxes()).toEqual([
      expect.objectContaining({ name: 'INBOX', attributes: ['\\Inbox'] }),
      expect.objectContaining({ name: 'Archive' }),
    ]);
    expect(await client.createMailbox('Receipts')).toEqual({
      status: 'success',
      message: "Mailbox 'Receipts' created successfully",
    });
    expect(await client.deleteMailbox('Archive')).toEqual({
      status: 'success',
      message: "Mailbox 'Archive' deleted successfully",
    });
    expect(
      await client.sendEmail({
        to: 'recipient@example.com',
        subject: 'Subject',
        text: 'Body',
      })
    ).toEqual({ messageId: 'sent-id' });
    expect(await client.testConnection()).toEqual(
      expect.objectContaining({ status: 'success' })
    );
    await client.disconnect();
    expect(imap.end).toHaveBeenCalled();
  });

  it('makes dateTo inclusive and fetches newest UIDs first', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    imap.search.mockImplementationOnce((_criteria, callback) =>
      callback(null, [10, 11, 12])
    );
    emitMessageFetch(imap, []);
    await client.searchMessages({
      query: 'invoice',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-17',
      limit: 2,
    });
    const criteria = imap.search.mock.calls[0][0];
    expect(criteria).toEqual(
      expect.arrayContaining([
        ['SINCE', new Date('2026-08-01T00:00:00.000Z')],
        ['BEFORE', new Date('2026-08-18T00:00:00.000Z')],
      ])
    );
    expect(imap.fetch).toHaveBeenCalledWith(
      [12, 11],
      expect.objectContaining({ bodies: '' })
    );
  });

  it('streams attachment metadata and caps returned message bodies', async () => {
    const client = new iCloudMailClient(config, { bodyLimitBytes: 5 });
    const imap = imapState.instances[0];
    imap.search.mockImplementationOnce((_criteria, callback) =>
      callback(null, [42])
    );
    emitMessageFetch(imap, [
      {
        uid: 42,
        flags: ['\\Seen'],
        source:
          'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Test\r\nDate: Mon, 17 Aug 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nabcdefghij\r\n--x\r\nContent-Type: text/plain; name="note.txt"\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\ndata\r\n--x--\r\n',
      },
    ]);
    const [message] = await client.getMessages();
    expect(message).toEqual(
      expect.objectContaining({
        id: '42',
        body: 'abcde',
        bodyTruncated: true,
        flags: ['\\Seen'],
        attachments: [
          expect.objectContaining({ index: 0, filename: 'note.txt', size: 4 }),
        ],
      })
    );
  });

  it('fetches and decodes only the selected attachment MIME part', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    imap.fetch
      .mockImplementationOnce(() => {
        const fetch = new MockFetch();
        queueMicrotask(() => {
          const message = new MockMessage();
          fetch.emit('message', message, 42);
          message.emit('body', Readable.from(['Subject: test\r\n\r\n']));
          message.emit('attributes', {
            uid: 42,
            struct: [
              {
                partID: '1',
                type: 'text',
                subtype: 'plain',
                size: 20,
              },
              {
                partID: '2',
                type: 'application',
                subtype: 'octet-stream',
                encoding: 'base64',
                size: 8,
                disposition: {
                  type: 'attachment',
                  params: { filename: 'one.bin' },
                },
              },
              {
                partID: '3',
                type: 'text',
                subtype: 'plain',
                encoding: 'base64',
                size: 8,
                disposition: {
                  type: 'attachment',
                  params: { filename: 'two.txt' },
                },
              },
            ],
          });
          message.emit('end');
          fetch.emit('end');
        });
        return fetch;
      })
      .mockImplementationOnce(() => {
        const fetch = new MockFetch();
        queueMicrotask(() => {
          const message = new MockMessage();
          fetch.emit('message', message, 42);
          message.emit('body', Readable.from(['dGVzdA==']));
          message.emit('end');
          fetch.emit('end');
        });
        return fetch;
      });
    const result = await client.downloadAttachment('42', 1, 'INBOX');
    expect(result.attachment).toEqual({
      filename: 'two.txt',
      contentType: 'text/plain',
      size: 4,
      data: 'dGVzdA==',
    });
    expect(imap.fetch).toHaveBeenNthCalledWith(
      2,
      [42],
      expect.objectContaining({ bodies: '3' })
    );
  });

  it('rejects oversized attachments from structure metadata before transfer', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    imap.fetch.mockImplementationOnce(() => {
      const fetch = new MockFetch();
      queueMicrotask(() => {
        const message = new MockMessage();
        fetch.emit('message', message, 42);
        message.emit('body', Readable.from(['']));
        message.emit('attributes', {
          uid: 42,
          struct: {
            partID: '2',
            type: 'application',
            subtype: 'zip',
            size: 10 * 1024 * 1024 + 1,
            disposition: {
              type: 'attachment',
              params: { filename: 'large.zip' },
            },
          },
        });
        message.emit('end');
        fetch.emit('end');
      });
      return fetch;
    });
    await expect(client.downloadAttachment('42')).rejects.toThrow(
      'exceeds the 10 MiB'
    );
    expect(imap.fetch).toHaveBeenCalledTimes(1);
  });

  it('enforces the attachment limit against decoded streamed bytes', async () => {
    const client = new iCloudMailClient(config, { attachmentLimitBytes: 3 });
    const imap = imapState.instances[0];
    imap.fetch
      .mockImplementationOnce(() => {
        const fetch = new MockFetch();
        queueMicrotask(() => {
          const message = new MockMessage();
          fetch.emit('message', message, 42);
          message.emit('body', Readable.from(['']));
          message.emit('attributes', {
            uid: 42,
            struct: {
              partID: '2',
              type: 'text',
              subtype: 'plain',
              encoding: 'base64',
              size: 1,
              disposition: {
                type: 'attachment',
                params: { filename: 'unexpected-size.txt' },
              },
            },
          });
          message.emit('end');
          fetch.emit('end');
        });
        return fetch;
      })
      .mockImplementationOnce(() => {
        const fetch = new MockFetch();
        queueMicrotask(() => {
          const message = new MockMessage();
          fetch.emit('message', message, 42);
          message.emit('body', Readable.from(['dGVzdA==']));
          message.emit('end');
          fetch.emit('end');
        });
        return fetch;
      });
    await expect(client.downloadAttachment('42')).rejects.toThrow(
      'exceeds the 10 MiB'
    );
  });

  it('fails parsing errors instead of silently dropping messages', async () => {
    const client = new iCloudMailClient(config);
    const imap = imapState.instances[0];
    imap.search.mockImplementationOnce((_criteria, callback) =>
      callback(null, [42])
    );
    imap.fetch.mockImplementationOnce(() => {
      const fetch = new MockFetch();
      queueMicrotask(() => {
        const message = new MockMessage();
        fetch.emit('message', message, 42);
        const stream = new Readable({ read() {} });
        message.emit('body', stream);
        message.emit('attributes', { uid: 42, flags: [] });
        stream.destroy(new Error('parser input failed'));
        message.emit('end');
        fetch.emit('end');
      });
      return fetch;
    });
    await expect(client.getMessages()).rejects.toThrow('parser input failed');
  });

  it('times out a stalled mailbox operation and resets the connection', async () => {
    vi.useFakeTimers();
    const client = new iCloudMailClient(config, { operationTimeoutMs: 20 });
    const imap = imapState.instances[0];
    imap.openBox.mockImplementation(() => undefined);
    const operation = client.getMessages();
    const rejection = expect(operation).rejects.toThrow('timed out');
    await vi.runAllTimersAsync();
    await rejection;
    expect(imap.destroy).toHaveBeenCalled();
  });

  it('applies ordered rules once per message and reports partial move failures', async () => {
    const client = new iCloudMailClient(config);
    vi.spyOn(client, 'getMessages').mockResolvedValue([
      {
        id: '1',
        from: 'news@example.com',
        to: [],
        subject: 'Daily news',
        body: '',
        bodyTruncated: false,
        date: new Date(),
        flags: [],
      },
      {
        id: '2',
        from: 'work@example.com',
        to: [],
        subject: 'Status',
        body: '',
        bodyTruncated: false,
        date: new Date(),
        flags: [],
      },
    ]);
    vi.spyOn(client, 'getMailboxes').mockResolvedValue([
      { name: 'News', attributes: [], delimiter: '/' },
      { name: 'Work', attributes: [], delimiter: '/' },
    ]);
    const move = vi
      .spyOn(client, 'moveMessages')
      .mockResolvedValueOnce({ status: 'success', message: 'moved' })
      .mockRejectedValueOnce(new Error('move failed'));
    const result = await client.autoOrganize(
      [
        {
          name: 'First',
          condition: { subjectContains: 'news' },
          action: { moveToMailbox: 'News' },
        },
        {
          name: 'Overlap',
          condition: { fromContains: 'news' },
          action: { moveToMailbox: 'Work' },
        },
        {
          name: 'Work',
          condition: { fromContains: 'work' },
          action: { moveToMailbox: 'Work' },
        },
      ],
      'INBOX',
      false
    );
    expect(move).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('partial');
    expect(result.results.map((entry) => entry.matchedMessages)).toEqual([
      1, 0, 1,
    ]);
    expect(result.results[2].error).toBe('move failed');
  });
});
