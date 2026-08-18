# Changelog

## v1.2.0 (2026-08-17)

### Security and reliability

- Added runtime-validated MCP input/output schemas, structured content, annotations, confirmation guards, and MCP error signaling.
- Serialized IMAP mailbox operations, added reconnection and operation timeouts, retained Apple username/full-address authentication fallback, and added graceful shutdown.
- Protected localized system mailboxes through IMAP attributes and restricted message mutations to numeric UIDs.
- Streamed message parsing and selective attachment downloads, capped bodies, and retained the 10 MiB attachment limit.
- Made organization rules ordered and first-match-wins, with dry-run by default, destination validation, a 100-message scan bound, and partial-failure reporting.

### Packaging and quality

- Added the `icloud-mail-mcp` executable, package file allowlist, clean builds, Node 22/24 CI, tag/version verification, package smoke testing, and enforced coverage thresholds.
- Updated and pinned vulnerable transitive dependencies so the production dependency audit has no findings.

---

## v1.1.1 (2025-08-17)

### Testing Infrastructure

- **Test Suite**: Added comprehensive test coverage with Vitest framework
  - Core client functionality tests
  - Type definition validation tests
  - Server configuration tests
- **Testing Scripts**: Added `test`, `test:ui`, and `test:run` commands
- **Documentation**: Enhanced README with detailed testing section

### Code Quality Improvements

- **Test Coverage**: 29 tests across 3 test files covering core functionality
- **Development Experience**: Added Vitest UI for interactive test development

### Technical Details

- Added Vitest and @vitest/ui dependencies
- Implemented proper mocking for external dependencies (IMAP, SMTP)
- Test isolation and cleanup for reliable test execution
- Real-world scenario testing reflecting actual usage patterns

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.1.0...v1.1.1

---

## v1.1.0 (2025-08-12)

### New Features

- **search_messages**: Advanced email search with multiple criteria (query text, date range, sender filtering)
- **delete_messages**: Bulk message deletion functionality with proper flag handling
- **set_flags**: Message flag management (add/remove flags like \\Seen, \\Flagged)
- **download_attachment**: Download specific attachments from messages with base64 encoding
- **auto_organize**: Intelligent email organization with customizable rules based on sender and subject

### Improvements

- Enhanced type safety with proper TypeScript interfaces
- Improved error handling across all new functions
- Better code organization with reusable components
- Consistent API design patterns

### Technical Details

- Added `SearchOptions` and `OrganizationRule` interfaces
- Implemented comprehensive IMAP search criteria handling
- Enhanced attachment processing with proper content type detection
- Dry-run capability for organization testing

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.0.2...v1.1.0

---

## v1.0.2 (2025-08-13)

### Documentation Improvements

- Reorganized README.md with collapsible sections for better readability
- Added comprehensive documentation for mailbox deletion functionality
- Improved tool documentation structure and examples
- Enhanced usage examples with categorized sections

### Technical Changes

- Simplified documentation structure for easier navigation
- Better organization of available tools and usage examples

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.0.1...v1.0.2

---

## v1.0.1 (2025-08-13)

### New Features

- Added `delete_mailbox` tool for safe mailbox deletion
- System mailbox protection (INBOX, Sent, Trash, Drafts, Junk)
- Enhanced error handling with descriptive messages

### Improvements

- Added ESLint and Prettier for code quality
- Updated all dependencies to latest versions
- Enhanced build process with esbuild integration

### Technical Changes

- Applied consistent code formatting
- Improved build scripts and configuration
- Enhanced input validation for mailbox operations

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/compare/v1.0.0...v1.0.1

---

## v1.0.0 (2025-07-22)

This is the initial release of iCloud Mail MCP Server.

**Full Changelog**: https://github.com/minagishl/icloud-mail-mcp/commits/v1.0.0
