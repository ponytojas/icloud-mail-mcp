export interface iCloudConfig {
  email: string;
  appPassword: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

export interface EmailMessage {
  /** Stable IMAP UID. Use this value for message-mutating tools. */
  id: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  /** True when the returned body was capped to the server's safety limit. */
  bodyTruncated: boolean;
  date: Date;
  flags: string[];
  attachments?: Attachment[];
}

export interface Attachment {
  /** Zero-based index accepted by download_attachment. */
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: Buffer;
    contentType?: string;
  }>;
}

export interface SearchOptions {
  query?: string;
  mailbox?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  fromEmail?: string;
  unreadOnly?: boolean;
}

export interface OrganizationRule {
  name: string;
  condition: {
    fromContains?: string;
    subjectContains?: string;
  };
  action: {
    moveToMailbox: string;
  };
}
