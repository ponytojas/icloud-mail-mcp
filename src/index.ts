#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iCloudMailClient } from './lib/icloud-mail-client.js';
import { createMailServer } from './server.js';
import { configSchema } from './schemas.js';

export { createMailServer } from './server.js';
export { iCloudMailClient } from './lib/icloud-mail-client.js';

export async function createClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<iCloudMailClient | null> {
  if (!env.ICLOUD_EMAIL && !env.ICLOUD_APP_PASSWORD) return null;
  const config = configSchema.parse({
    email: env.ICLOUD_EMAIL,
    appPassword: env.ICLOUD_APP_PASSWORD,
    imapHost: env.ICLOUD_IMAP_HOST ?? 'imap.mail.me.com',
    imapPort: env.ICLOUD_IMAP_PORT ? Number(env.ICLOUD_IMAP_PORT) : undefined,
    smtpHost: env.ICLOUD_SMTP_HOST ?? 'smtp.mail.me.com',
    smtpPort: env.ICLOUD_SMTP_PORT ? Number(env.ICLOUD_SMTP_PORT) : undefined,
  });
  const client = new iCloudMailClient(config);
  await client.connect();
  return client;
}

export async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'iCloud Mail MCP Server\n\nSet ICLOUD_EMAIL and ICLOUD_APP_PASSWORD, then run this executable as a stdio MCP server.\n'
    );
    return;
  }

  let mailClient: iCloudMailClient | null = null;
  try {
    mailClient = await createClientFromEnv();
    if (mailClient) console.error('Auto-configured iCloud Mail');
  } catch (error) {
    console.error('Failed to auto-configure iCloud Mail:', error);
  }

  const server = createMailServer({ mailClient, env: process.env });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
      await mailClient?.disconnect();
    } catch (error) {
      console.error('Graceful shutdown failed:', error);
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.connect(new StdioServerTransport());
  console.error('iCloud Mail MCP Server running on stdio');
}

const isExecutable =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url));

if (isExecutable) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exitCode = 1;
  });
}
