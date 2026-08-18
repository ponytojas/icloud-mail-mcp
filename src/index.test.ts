import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { iCloudMailClient } from './lib/icloud-mail-client.js';
import { createMailServer } from './server.js';

const message = {
  id: '42',
  from: 'sender@example.com',
  to: ['recipient@example.com'],
  subject: 'Subject',
  body: 'Body',
  bodyTruncated: false,
  date: new Date('2026-08-17T10:00:00.000Z'),
  flags: [],
  attachments: [
    { index: 0, filename: 'note.txt', contentType: 'text/plain', size: 4 },
  ],
};

function makeMailClient() {
  return {
    getMessages: vi.fn().mockResolvedValue([message]),
    sendEmail: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi
      .fn()
      .mockResolvedValue([
        { name: 'INBOX', attributes: ['\\Inbox'], delimiter: '/' },
      ]),
    testConnection: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'connected',
    }),
    createMailbox: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'created',
    }),
    deleteMailbox: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'deleted',
    }),
    moveMessages: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'moved',
    }),
    searchMessages: vi.fn().mockResolvedValue([message]),
    deleteMessages: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'deleted',
    }),
    setFlags: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'flags set',
    }),
    downloadAttachment: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'downloaded',
      attachment: {
        filename: 'note.txt',
        contentType: 'text/plain',
        size: 4,
        data: 'dGVzdA==',
      },
    }),
    autoOrganize: vi.fn().mockResolvedValue({
      status: 'success',
      message: 'organized',
      results: [],
    }),
  };
}

describe('MCP server', () => {
  let sdkClient: Client;
  let mailClient: ReturnType<typeof makeMailClient>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    mailClient = makeMailClient();
    const server = createMailServer({
      mailClient: mailClient as unknown as iCloudMailClient,
      env: {
        ICLOUD_EMAIL: 'test@icloud.com',
        ICLOUD_APP_PASSWORD: 'secret',
      },
    });
    sdkClient = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      sdkClient.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    close = async () => {
      await sdkClient.close();
      await server.close();
    };
  });

  afterEach(async () => close());

  it('discovers every existing tool with schemas and explicit annotations', async () => {
    const { tools } = await sdkClient.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_messages',
      'send_email',
      'mark_as_read',
      'get_mailboxes',
      'test_connection',
      'create_mailbox',
      'delete_mailbox',
      'move_messages',
      'search_messages',
      'delete_messages',
      'set_flags',
      'download_attachment',
      'auto_organize',
      'check_config',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        })
      );
    }
    expect(
      tools.find((tool) => tool.name === 'delete_messages')?.annotations
        ?.destructiveHint
    ).toBe(true);
    expect(
      tools.find((tool) => tool.name === 'get_messages')?.annotations
        ?.readOnlyHint
    ).toBe(true);
  });

  it('returns structured messages while retaining the JSON text fallback', async () => {
    const result = await sdkClient.callTool({
      name: 'get_messages',
      arguments: { limit: 5 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      messages: [
        expect.objectContaining({
          id: '42',
          date: '2026-08-17T10:00:00.000Z',
          bodyTruncated: false,
          attachments: [expect.objectContaining({ index: 0 })],
        }),
      ],
    });
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('42'),
      }),
    ]);
  });

  it('rejects invalid UIDs and missing mutation confirmation before execution', async () => {
    const invalidUid = await sdkClient.callTool({
      name: 'mark_as_read',
      arguments: { messageIds: ['message-id'], confirm: true },
    });
    const missingConfirmation = await sdkClient.callTool({
      name: 'mark_as_read',
      arguments: { messageIds: ['42'] },
    });
    expect(invalidUid.isError).toBe(true);
    expect(missingConfirmation.isError).toBe(true);
    expect(mailClient.markAsRead).not.toHaveBeenCalled();
  });

  it('requires confirmation only when auto_organize is not a dry run', async () => {
    const rules = [
      {
        name: 'News',
        condition: { subjectContains: 'news' },
        action: { moveToMailbox: 'News' },
      },
    ];
    const dryRun = await sdkClient.callTool({
      name: 'auto_organize',
      arguments: { rules },
    });
    const executeWithoutConfirmation = await sdkClient.callTool({
      name: 'auto_organize',
      arguments: { rules, dryRun: false },
    });
    expect(dryRun.isError).not.toBe(true);
    expect(mailClient.autoOrganize).toHaveBeenCalledWith(rules, 'INBOX', true);
    expect(executeWithoutConfirmation.isError).toBe(true);
  });

  it('marks operational failures as MCP errors', async () => {
    mailClient.getMailboxes.mockRejectedValueOnce(new Error('connection lost'));
    const result = await sdkClient.callTool({
      name: 'get_mailboxes',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: 'error',
      message: 'connection lost',
    });
  });

  it('routes every remaining tool through validated client calls', async () => {
    const calls = [
      {
        name: 'send_email',
        arguments: {
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'Body',
          confirm: true,
        },
      },
      {
        name: 'mark_as_read',
        arguments: { messageIds: ['42'], confirm: true },
      },
      { name: 'test_connection', arguments: {} },
      {
        name: 'create_mailbox',
        arguments: { name: 'Receipts', confirm: true },
      },
      {
        name: 'delete_mailbox',
        arguments: { name: 'Receipts', confirm: true },
      },
      {
        name: 'move_messages',
        arguments: {
          messageIds: ['42'],
          sourceMailbox: 'INBOX',
          destinationMailbox: 'Archive',
          confirm: true,
        },
      },
      {
        name: 'search_messages',
        arguments: {
          query: 'invoice',
          dateFrom: '2026-08-01',
          dateTo: '2026-08-17',
        },
      },
      {
        name: 'delete_messages',
        arguments: { messageIds: ['42'], confirm: true },
      },
      {
        name: 'set_flags',
        arguments: {
          messageIds: ['42'],
          flags: ['\\Flagged'],
          action: 'add',
          confirm: true,
        },
      },
      {
        name: 'download_attachment',
        arguments: { messageId: '42', attachmentIndex: 0 },
      },
    ];
    for (const call of calls) {
      const result = await sdkClient.callTool(call);
      expect(result.isError, call.name).not.toBe(true);
      expect(result.structuredContent, call.name).toBeDefined();
    }
    expect(mailClient.sendEmail).toHaveBeenCalled();
    expect(mailClient.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ dateTo: '2026-08-17' })
    );
    expect(mailClient.downloadAttachment).toHaveBeenCalledWith(
      '42',
      0,
      'INBOX'
    );
  });

  it('strictly validates dates, flags, recipients, and bounded arrays', async () => {
    const invalidCalls = [
      {
        name: 'search_messages',
        arguments: { dateFrom: '2026-02-30' },
      },
      {
        name: 'set_flags',
        arguments: {
          messageIds: ['42'],
          flags: ['bad flag'],
          confirm: true,
        },
      },
      {
        name: 'send_email',
        arguments: {
          to: 'invalid',
          subject: 'Hello',
          text: 'Body',
          confirm: true,
        },
      },
      {
        name: 'auto_organize',
        arguments: {
          rules: [
            {
              name: 'Empty',
              condition: {},
              action: { moveToMailbox: 'Archive' },
            },
          ],
        },
      },
    ];
    for (const call of invalidCalls) {
      expect((await sdkClient.callTool(call)).isError, call.name).toBe(true);
    }
  });

  it('reports configuration without exposing credential values', async () => {
    const result = await sdkClient.callTool({
      name: 'check_config',
      arguments: {},
    });
    expect(result.structuredContent).toEqual({
      email: { configured: true },
      appPassword: { configured: true },
      connectionStatus: 'Connected',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
