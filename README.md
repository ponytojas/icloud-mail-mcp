# iCloud Mail MCP Server

A Model Context Protocol (MCP) server for integrating with iCloud Mail using App Password authentication. This server provides tools to read, send, and manage emails through iCloud's IMAP and SMTP services.

> Development logs for this project are being shared on [Hack Club's Summer of Making](https://summer.hackclub.com/projects/7559). Check it out to follow the development journey!

## Features

- **Secure Authentication**: Uses App-specific passwords for secure iCloud Mail access
- **Email Management**: Read, send, and organize emails
- **Mailbox Operations**: List mailboxes, mark messages as read
- **Attachment Support**: Handle email attachments
- **MCP Integration**: Seamless integration with MCP-compatible clients

## Prerequisites

1. **iCloud Account**: You need an active iCloud account with Mail enabled
2. **App Password**: Generate an app-specific password for Mail access:
   - Sign in to [appleid.apple.com](https://appleid.apple.com)
   - Go to "Sign-In and Security" > "App-Specific Passwords"
   - Generate a new password for "Mail"
   - Save this password securely

## Installation

Run the published package directly from an MCP client:

```json
{
  "icloud-mail-mcp": {
    "command": "npx",
    "args": ["-y", "icloud-mail-mcp@1.2.0"],
    "env": {
      "ICLOUD_EMAIL": "your-email@icloud.com",
      "ICLOUD_APP_PASSWORD": "your-app-specific-password"
    }
  }
}
```

For local development:

```bash
# Clone the repository
git clone https://github.com/minagishl/icloud-mail-mcp.git
cd icloud-mail-mcp

# Install dependencies using pnpm
pnpm install

# Build the project
pnpm run build
```

## Configuration

The server requires environment variables for authentication. Configuration is done exclusively through your MCP client settings; there is no runtime configuration tool.

### Environment Variables (Required)

Add to your MCP server configuration:

```json
{
  "icloud-mail-mcp": {
    "command": "node",
    "args": ["/path/to/icloud-mail-mcp/dist/index.js"],
    "env": {
      "ICLOUD_EMAIL": "your-email@icloud.com",
      "ICLOUD_APP_PASSWORD": "your-app-specific-password"
    }
  }
}
```

## Available Tools

<details>
<summary><strong>Click to view all available tools</strong></summary>

### Email Operations

#### `get_messages`

Retrieve email messages from a specified mailbox.

Results are newest-first. Bodies are capped and report `bodyTruncated`; attachments include the `index` accepted by `download_attachment`.

**Parameters:**

- `mailbox` (string, optional): Mailbox name (default: "INBOX")
- `limit` (number, optional): Maximum number of messages to retrieve (default: 10)
- `unreadOnly` (boolean, optional): Retrieve only unread messages (default: false)

#### `send_email`

Send an email through iCloud Mail.

**Parameters:**

- `to` (string or array, required): Valid recipient email address(es), up to 50
- `subject` (string, required): Email subject
- `text` (string, optional): Plain text email body
- `html` (string, optional): HTML email body
- `confirm` (boolean, required): Must be `true` after explicit user approval

#### `mark_as_read`

Mark email messages as read.

**Parameters:**

- `messageIds` (array, required): Numeric IMAP UIDs returned by a read/search tool
- `mailbox` (string, optional): Mailbox name (default: "INBOX")
- `confirm` (boolean, required): Must be `true` after explicit user approval

#### `move_messages`

Move messages between mailboxes.

**Parameters:**

- `messageIds` (array, required): Numeric IMAP UIDs to move
- `sourceMailbox` (string, required): Source mailbox name
- `destinationMailbox` (string, required): Destination mailbox name
- `confirm` (boolean, required): Must be `true` after explicit user approval

#### `search_messages`

Search for messages using various criteria.

**Parameters:**

- `query` (string, optional): Search query text (searches subject and body)
- `mailbox` (string, optional): Mailbox name (default: "INBOX")
- `limit` (number, optional): Maximum number of messages to retrieve (default: 10)
- `dateFrom` (string, optional): Start date for search (YYYY-MM-DD format)
- `dateTo` (string, optional): Inclusive end date (YYYY-MM-DD format)
- `fromEmail` (string, optional): Filter by sender email address
- `unreadOnly` (boolean, optional): Search only unread messages (default: false)

#### `delete_messages`

Delete messages from a mailbox.

**Parameters:**

- `messageIds` (array, required): Numeric IMAP UIDs to delete
- `mailbox` (string, optional): Mailbox name (default: "INBOX")
- `confirm` (boolean, required): Must be `true` after explicit user approval

#### `set_flags`

Set flags on messages (read, unread, flagged, etc.).

**Parameters:**

- `messageIds` (array, required): Numeric IMAP UIDs to change
- `flags` (array, required): Array of flags to set (e.g., ["\\Seen", "\\Flagged"])
- `mailbox` (string, optional): Mailbox name (default: "INBOX")
- `action` (string, optional): Whether to "add" or "remove" the flags (default: "add")
- `confirm` (boolean, required): Must be `true` after explicit user approval

#### `download_attachment`

Download an attachment from a specific message.

**Parameters:**

- `messageId` (string, required): Numeric IMAP UID containing the attachment
- `attachmentIndex` (number, optional): Index of the attachment to download (0-based, default: 0)
- `mailbox` (string, optional): Mailbox name (default: "INBOX")

#### `auto_organize`

Automatically organize emails based on rules (sender, subject keywords, etc.).

**Parameters:**

- `rules` (array, required): Array of organization rules with conditions and actions
- `sourceMailbox` (string, optional): Source mailbox to organize (default: "INBOX")
- `dryRun` (boolean, optional): If true, only shows what would be organized without moving emails (default: true)
- `confirm` (boolean, conditionally required): Required when `dryRun` is `false`

Rules run in their supplied order and the first matching rule wins. Each scan is intentionally limited to the newest 100 messages in the source mailbox.

**Rule Structure:**

```json
{
  "name": "Rule name",
  "condition": {
    "fromContains": "sender keyword",
    "subjectContains": "subject keyword"
  },
  "action": {
    "moveToMailbox": "destination folder"
  }
}
```

### Mailbox Management

#### `get_mailboxes`

List all available mailboxes in your iCloud Mail account.

**Parameters:** None

#### `create_mailbox`

Create a new mailbox (folder) in your iCloud Mail account.

**Parameters:**

- `name` (string, required): Name of the mailbox to create
- `confirm` (boolean, required): Must be `true` after explicit user approval

#### `delete_mailbox`

Delete an existing mailbox (folder) from your iCloud Mail account.

**Parameters:**

- `name` (string, required): Name of the mailbox to delete
- `confirm` (boolean, required): Must be `true` after explicit user approval

**Safety Features:**

- Prevents deletion of system mailboxes using IMAP special-use attributes, including localized folder names
- Validates mailbox name input
- Provides detailed error messages for common issues

### System Tools

#### `test_connection`

Test the email server connection to verify IMAP and SMTP connectivity.

**Parameters:** None

#### `check_config`

Check if environment variables are properly configured and show connection status.

**Parameters:** None

</details>

## Usage Example

<details>
<summary><strong>Click to view usage examples</strong></summary>

### Getting Started

**Start the MCP server:**

```bash
# With environment variables (recommended)
ICLOUD_EMAIL="your-email@icloud.com" ICLOUD_APP_PASSWORD="your-app-password" pnpm run start

```

### Email Operations

**Get recent messages:**

```json
{
  "tool": "get_messages",
  "arguments": {
    "limit": 5,
    "unreadOnly": true
  }
}
```

**Send an email:**

```json
{
  "tool": "send_email",
  "arguments": {
    "to": "recipient@example.com",
    "subject": "Hello from MCP",
    "text": "This email was sent using the iCloud Mail MCP server!",
    "confirm": true
  }
}
```

**Move messages between mailboxes:**

```json
{
  "tool": "move_messages",
  "arguments": {
    "messageIds": ["1042", "1043"],
    "sourceMailbox": "INBOX",
    "destinationMailbox": "My Custom Folder",
    "confirm": true
  }
}
```

### Mailbox Management

**Create a new mailbox:**

```json
{
  "tool": "create_mailbox",
  "arguments": {
    "name": "My Custom Folder",
    "confirm": true
  }
}
```

**Delete a mailbox:**

```json
{
  "tool": "delete_mailbox",
  "arguments": {
    "name": "My Custom Folder",
    "confirm": true
  }
}
```

### System Tools

**Test connection:**

```json
{
  "tool": "test_connection",
  "arguments": {}
}
```

**Check configuration:**

```json
{
  "tool": "check_config",
  "arguments": {}
}
```

</details>

## Security Notes

- **App Passwords**: Always use app-specific passwords, never your main iCloud password
- **Secure Storage**: Store your app password securely and never commit it to version control
- **Connection Security**: IMAP and SMTP require a valid TLS certificate; self-signed or intercepted certificates are rejected.
- **Minimal Permissions**: The server only accesses Mail functionality
- **Message IDs**: The `id` returned by `get_messages` and `search_messages` is an IMAP UID. Pass only those IDs to message-mutating tools; they affect exactly the supplied UIDs.
- **Explicit confirmation**: Sending mail and every mailbox/message mutation require `confirm: true`. Only set it after the user has reviewed and explicitly approved the precise action.
- **Consent boundary**: Tool annotations and `confirm` support safer client workflows, but client-side user consent and access controls are the actual security boundary.
- **Safe automation**: `auto_organize` defaults to `dryRun: true`. Review its planned result first; execution additionally requires `dryRun: false` and `confirm: true`.
- **Attachments**: Message listing returns attachment metadata only. `download_attachment` is an explicit operation and refuses attachments over 10 MiB.
- **Untrusted content**: Email bodies and attachments can contain prompt injection or misleading instructions. Treat them as untrusted data and do not let an LLM turn email content into tool calls without independent user review.

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm run dev

# Build the project
pnpm run build

# Type checking
pnpm run typecheck

# Run tests
pnpm run test

# Run linting
pnpm run lint
```

### Temporary Dependency Overrides

`package.json` temporarily pins patched transitive releases used by the MCP SDK, Mailparser, and IMAP (`path-to-regexp`, `semver`, `fast-uri`, `ip-address`, `deepmerge-ts`, `qs`, `hono`, and `@hono/node-server`). These overrides keep `pnpm audit --prod` clean and can be removed as upstream dependency ranges adopt the patched versions.

## Testing

This project includes comprehensive test coverage using Vitest. The test suite covers:

### Test Structure

- **Coverage gates**: At least 80% for statements, lines, and functions and 70% for branches
- **Current suite**: 37 tests across 3 test files, including in-memory MCP integration tests
- **Framework**: Vitest with TypeScript support
- **Coverage**: Core functionality, type definitions, and configuration

### Test Categories

#### 1. Core Client Tests (`src/lib/icloud-mail-client.test.ts`)

- **Connection lifecycle**: Authentication fallback, dropped-session reconnection, shutdown, and timeouts
- **Mailbox safety**: Serialized selection, numeric UID targeting, and localized system-folder protection
- **Message handling**: Body truncation, parser errors, MIME-part attachment streaming, size limits, and inclusive date searches
- **Automation**: Ordered first-match behavior and partial move failures

#### 2. Type Definition Tests (`src/types/config.test.ts`)

- **iCloudConfig**: Tests configuration object structure
- **EmailMessage**: Tests email message data types
- **SendEmailOptions**: Tests email sending parameter validation
- **SearchOptions**: Tests search parameter structures
- **OrganizationRule**: Tests email organization rule definitions
- **Attachment**: Tests attachment data structures

#### 3. MCP Integration Tests (`src/index.test.ts`)

- **Discovery**: Tool names, schemas, output schemas, and annotations
- **Validation**: Confirmation guards, dates, recipients, flags, UIDs, and rule definitions
- **Protocol results**: Structured content, text fallbacks, and `isError` signaling over an in-memory MCP transport

### Running Tests

```bash
# Run all tests once
pnpm run test:run

# Run tests in watch mode (interactive)
pnpm run test

# Run tests with UI interface
pnpm run test:ui

# Enforce coverage thresholds
pnpm run test:coverage
```

### Test Features

- **Type Safety**: All tests are written in TypeScript without using `any`
- **Mocking**: External dependencies (IMAP, SMTP) are properly mocked
- **Coverage**: Tests cover both happy path and edge cases
- **Isolation**: Each test is independent and properly cleaned up
- **Real-world scenarios**: Tests reflect actual usage patterns

## Troubleshooting

### Authentication Issues

- Verify your app password is correct and hasn't expired
- Ensure two-factor authentication is enabled on your iCloud account
- Check that Mail is enabled in your iCloud settings

### Connection Problems

- Verify internet connectivity
- Check if iCloud Mail servers are accessible
- Ensure firewall settings allow connections to imap.mail.me.com and smtp.mail.me.com
- Dropped IMAP sessions reconnect automatically on the next tool call. If reconnects repeatedly fail, regenerate the app-specific password and restart the MCP client.

### Email Not Sending

- Verify SMTP settings and authentication
- Check recipient email addresses are valid
- Ensure you're not hitting rate limits

### Localized Mailboxes

- Use `get_mailboxes` to discover the exact mailbox path exposed by iCloud. System folders may have localized names and are protected through their IMAP attributes.

### Large Messages and Attachments

- Returned message bodies are capped and include `bodyTruncated: true` when shortened.
- Listings expose attachment metadata and a zero-based `index` without retaining attachment bytes. `download_attachment` retrieves only that MIME part and rejects downloads over 10 MiB.

## iCloud Mail Server Settings

The server uses the following default settings for iCloud Mail:

- **IMAP Server**: imap.mail.me.com (Port: 993, SSL: Yes)
- **SMTP Server**: smtp.mail.me.com (Port: 587, TLS: Yes)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
