import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { commonSchemas } from './schemas.js';
import type { iCloudMailClient } from './lib/icloud-mail-client.js';

const VERSION = '1.2.0';
const NOT_CONFIGURED =
  'iCloud Mail not configured. Please set ICLOUD_EMAIL and ICLOUD_APP_PASSWORD environment variables.';

const attachmentOutputSchema = z.object({
  index: z.number().int().min(0),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().min(0),
});
const messageOutputSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  date: z.string(),
  flags: z.array(z.string()),
  attachments: z.array(attachmentOutputSchema).optional(),
});
const operationOutputSchema = z.object({
  status: z.literal('success'),
  message: z.string(),
});
const mailboxOutputSchema = z.object({
  name: z.string(),
  attributes: z.array(z.string()),
  delimiter: z.string(),
  children: z.array(z.unknown()).optional(),
});
const annotations = (
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean
): ToolAnnotations => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint,
});

function textResult<T extends object>(
  structuredContent: T,
  text: string
): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: Object.assign({}, structuredContent) as Record<
      string,
      unknown
    >,
  };
}

function jsonResult<T extends object>(structuredContent: T): CallToolResult {
  return textResult(
    structuredContent,
    JSON.stringify(structuredContent, null, 2)
  );
}

function toolError(name: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      { type: 'text', text: `Error executing tool ${name}: ${message}` },
    ],
    structuredContent: { status: 'error', message },
    isError: true,
  };
}

function requireClient(client: iCloudMailClient | null): iCloudMailClient {
  if (!client) throw new Error(NOT_CONFIGURED);
  return client;
}

function serializeMessages(
  messages: Awaited<ReturnType<iCloudMailClient['getMessages']>>
) {
  return messages.map((message) => ({
    ...message,
    date: message.date.toISOString(),
  }));
}

function guarded(
  name: string,
  callback: () => Promise<CallToolResult> | CallToolResult
) {
  return async (): Promise<CallToolResult> => {
    try {
      return await callback();
    } catch (error) {
      return toolError(name, error);
    }
  };
}

function guardedWith<T>(
  name: string,
  callback: (args: T) => Promise<CallToolResult> | CallToolResult
) {
  return async (args: T): Promise<CallToolResult> => {
    try {
      return await callback(args);
    } catch (error) {
      return toolError(name, error);
    }
  };
}

export interface MailServerOptions {
  mailClient?: iCloudMailClient | null;
  env?: NodeJS.ProcessEnv;
}

export function createMailServer(options: MailServerOptions = {}): McpServer {
  const client = options.mailClient ?? null;
  const env = options.env ?? process.env;
  const server = new McpServer({ name: 'icloud-mail-mcp', version: VERSION });

  server.registerTool(
    'get_messages',
    {
      description: 'Get recent email messages, newest first',
      inputSchema: commonSchemas.mailboxOptions,
      outputSchema: z.object({ messages: z.array(messageOutputSchema) }),
      annotations: annotations(true, false, true, true),
    },
    guardedWith('get_messages', async ({ mailbox, limit, unreadOnly }) => {
      const messages = await requireClient(client).getMessages(
        mailbox,
        limit,
        unreadOnly
      );
      return textResult(
        { messages: serializeMessages(messages) },
        JSON.stringify(messages, null, 2)
      );
    })
  );

  server.registerTool(
    'send_email',
    {
      description:
        'Send an email through iCloud Mail. Requires explicit user confirmation.',
      inputSchema: commonSchemas.sendEmail,
      outputSchema: z.object({
        status: z.literal('success'),
        messageId: z.string(),
      }),
      annotations: annotations(false, false, false, true),
    },
    guardedWith('send_email', async ({ to, subject, text, html }) => {
      const result = await requireClient(client).sendEmail({
        to,
        subject,
        text,
        html,
      });
      return textResult(
        { status: 'success', messageId: result.messageId },
        `Email sent successfully. Message ID: ${result.messageId}`
      );
    })
  );

  server.registerTool(
    'mark_as_read',
    {
      description:
        'Mark selected messages as read. Requires explicit user confirmation.',
      inputSchema: commonSchemas.messageMutation,
      outputSchema: z.object({
        status: z.literal('success'),
        count: z.number(),
      }),
      annotations: annotations(false, false, true, true),
    },
    guardedWith('mark_as_read', async ({ messageIds, mailbox }) => {
      await requireClient(client).markAsRead(messageIds, mailbox);
      return textResult(
        { status: 'success', count: messageIds.length },
        `Marked ${messageIds.length} messages as read`
      );
    })
  );

  server.registerTool(
    'get_mailboxes',
    {
      description: 'List all available mailboxes and their IMAP attributes',
      inputSchema: commonSchemas.empty,
      outputSchema: z.object({ mailboxes: z.array(mailboxOutputSchema) }),
      annotations: annotations(true, false, true, true),
    },
    guarded('get_mailboxes', async () => {
      const mailboxes = await requireClient(client).getMailboxes();
      return textResult({ mailboxes }, JSON.stringify(mailboxes, null, 2));
    })
  );

  server.registerTool(
    'test_connection',
    {
      description: 'Test the IMAP and SMTP connections',
      inputSchema: commonSchemas.empty,
      outputSchema: operationOutputSchema,
      annotations: annotations(true, false, true, true),
    },
    guarded('test_connection', async () =>
      jsonResult(await requireClient(client).testConnection())
    )
  );

  server.registerTool(
    'create_mailbox',
    {
      description:
        'Create a mailbox. Requires explicit user confirmation; client consent remains the security boundary.',
      inputSchema: commonSchemas.mailboxMutation,
      outputSchema: operationOutputSchema,
      annotations: annotations(false, false, true, true),
    },
    guardedWith('create_mailbox', async ({ name }) =>
      jsonResult(await requireClient(client).createMailbox(name))
    )
  );

  server.registerTool(
    'delete_mailbox',
    {
      description:
        'Delete a non-system mailbox. Requires explicit user confirmation.',
      inputSchema: commonSchemas.mailboxMutation,
      outputSchema: operationOutputSchema,
      annotations: annotations(false, true, true, true),
    },
    guardedWith('delete_mailbox', async ({ name }) =>
      jsonResult(await requireClient(client).deleteMailbox(name))
    )
  );

  server.registerTool(
    'move_messages',
    {
      description:
        'Move selected numeric IMAP UIDs between mailboxes. Requires explicit user confirmation.',
      inputSchema: commonSchemas.moveMessages,
      outputSchema: operationOutputSchema,
      annotations: annotations(false, false, true, true),
    },
    guardedWith(
      'move_messages',
      async ({ messageIds, sourceMailbox, destinationMailbox }) =>
        jsonResult(
          await requireClient(client).moveMessages(
            messageIds,
            sourceMailbox,
            destinationMailbox
          )
        )
    )
  );

  server.registerTool(
    'search_messages',
    {
      description:
        'Search messages by subject/body text, sender, inclusive date range, and unread state; returns newest first',
      inputSchema: commonSchemas.searchMessages,
      outputSchema: z.object({ messages: z.array(messageOutputSchema) }),
      annotations: annotations(true, false, true, true),
    },
    guardedWith('search_messages', async (args) => {
      const messages = await requireClient(client).searchMessages(args);
      return textResult(
        { messages: serializeMessages(messages) },
        JSON.stringify(messages, null, 2)
      );
    })
  );

  server.registerTool(
    'delete_messages',
    {
      description:
        'Permanently delete selected numeric IMAP UIDs. Requires explicit user confirmation.',
      inputSchema: commonSchemas.messageMutation,
      outputSchema: operationOutputSchema,
      annotations: annotations(false, true, true, true),
    },
    guardedWith('delete_messages', async ({ messageIds, mailbox }) =>
      jsonResult(
        await requireClient(client).deleteMessages(messageIds, mailbox)
      )
    )
  );

  server.registerTool(
    'set_flags',
    {
      description:
        'Add or remove flags on selected numeric IMAP UIDs. Requires explicit user confirmation.',
      inputSchema: commonSchemas.setFlags,
      outputSchema: operationOutputSchema,
      annotations: annotations(false, false, true, true),
    },
    guardedWith('set_flags', async ({ messageIds, flags, mailbox, action }) =>
      jsonResult(
        await requireClient(client).setFlags(messageIds, flags, mailbox, action)
      )
    )
  );

  server.registerTool(
    'download_attachment',
    {
      description:
        'Download one attachment by its zero-based index, up to 10 MiB',
      inputSchema: commonSchemas.downloadAttachment,
      outputSchema: z.object({
        status: z.literal('success'),
        message: z.string(),
        attachment: z.object({
          filename: z.string(),
          contentType: z.string(),
          size: z.number().int().min(0),
          data: z.string(),
        }),
      }),
      annotations: annotations(true, false, true, true),
    },
    guardedWith(
      'download_attachment',
      async ({ messageId, attachmentIndex, mailbox }) =>
        jsonResult(
          await requireClient(client).downloadAttachment(
            messageId,
            attachmentIndex,
            mailbox
          )
        )
    )
  );

  server.registerTool(
    'auto_organize',
    {
      description:
        'Apply ordered rules to at most the newest 100 messages; first match wins and dry-run is the default',
      inputSchema: commonSchemas.autoOrganize,
      outputSchema: z.object({
        status: z.enum(['success', 'partial']),
        message: z.string(),
        results: z.array(
          z.object({
            rule: z.string(),
            matchedMessages: z.number().int().min(0),
            moved: z.boolean(),
            error: z.string().optional(),
            messages: z
              .array(
                z.object({
                  id: z.string(),
                  from: z.string(),
                  subject: z.string(),
                  destinationMailbox: z.string(),
                })
              )
              .optional(),
          })
        ),
      }),
      annotations: annotations(false, false, false, true),
    },
    guardedWith('auto_organize', async ({ rules, sourceMailbox, dryRun }) => {
      const result = await requireClient(client).autoOrganize(
        rules,
        sourceMailbox,
        dryRun
      );
      const response = jsonResult(result);
      if (result.status === 'partial') response.isError = true;
      return response;
    })
  );

  server.registerTool(
    'check_config',
    {
      description: 'Check environment configuration and connection status',
      inputSchema: commonSchemas.empty,
      outputSchema: z.object({
        email: z.object({ configured: z.boolean() }),
        appPassword: z.object({ configured: z.boolean() }),
        connectionStatus: z.enum(['Connected', 'Not connected']),
      }),
      annotations: annotations(true, false, true, false),
    },
    guarded('check_config', () =>
      jsonResult({
        email: { configured: Boolean(env.ICLOUD_EMAIL) },
        appPassword: { configured: Boolean(env.ICLOUD_APP_PASSWORD) },
        connectionStatus: client ? 'Connected' : 'Not connected',
      })
    )
  );

  return server;
}
