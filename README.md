# Apple Mail MCP

A local, stdio-based [Model Context Protocol](https://modelcontextprotocol.io/) server for Apple Mail on macOS.

It talks only to the Apple Mail app already configured on the user's Mac. It does not need IMAP/SMTP passwords or open a network port.

## Safety model

- Mailbox and message tools are read-only by default.
- `create_draft` opens an unsent, visible draft in Apple Mail.
- `send_email` requires `user_approved: true`. MCP clients should call it only after the user has approved the exact message.
- Message changes such as marking, flagging, and moving also require `user_approved: true`.
- Dynamic content is passed to `osascript` as arguments, not interpolated into AppleScript source.
- Every write action has a local, metadata-only JSONL audit entry. Bodies and credentials are never written to that log.
- The approval inbox and relationship context are stored only in the local JSON data store described below.

The MCP server itself is local. However, an MCP client may send tool results to an AI model or another service. Only connect clients and models you trust with mail content.

## Requirements

- macOS with Apple Mail configured
- Node.js 20+
- Permission for the host application (for example Codex or Terminal) to control Mail under **System Settings → Privacy & Security → Automation**

## Install

### npm (recommended)

```bash
npm install -g @jakobf1/apple-mail-mcp
```

Then configure your MCP client with the installed command:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "apple-mail-mcp"
    }
  }
}
```

### From source

```bash
git clone https://github.com/YOUR_ACCOUNT/apple-mail-mcp.git
cd apple-mail-mcp
npm install
npm run build
```

## Add to an MCP client

If you installed from source rather than npm, use the compiled server over stdio:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/absolute/path/to/apple-mail-mcp/dist/index.js"]
    }
  }
}
```

Restart the MCP client after saving its configuration. The first call will trigger the normal macOS automation permission prompt.

### Optional sender policy

To allow sending only from specific configured Apple Mail addresses, configure a comma-separated allowlist when launching the server:

```json
{
  "env": {
    "APPLE_MAIL_MCP_ALLOWED_SENDERS": "hello@example.com"
  }
}
```

Write-action audit metadata is stored locally at `~/.apple-mail-mcp/audit.jsonl` by default. Set `APPLE_MAIL_MCP_AUDIT_LOG` to use another local path.

### AI-first local workspace

The approval inbox and relationship context share a local JSON store at `~/.apple-mail-mcp/data.json` by default. It contains queued draft bodies and the contact notes you intentionally save, so treat it as private mail data. Set `APPLE_MAIL_MCP_DATA_STORE` to use another local path.

`APPLE_MAIL_MCP_DRY_RUN=true` validates sends but prevents delivery. You can also enforce recipient restrictions with `APPLE_MAIL_MCP_ALLOWED_RECIPIENTS`, `APPLE_MAIL_MCP_ALLOWED_RECIPIENT_DOMAINS`, and a local time window such as `APPLE_MAIL_MCP_SENDING_WINDOW=09:00-18:00`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_accounts` | Lists configured Apple Mail accounts and sender addresses. |
| `list_mailboxes` | Lists the top-level mailboxes in an account. |
| `list_messages` | Returns inbox or mailbox summaries without message bodies. |
| `search_messages` | Searches recent messages by sender or subject. |
| `get_message` | Reads one message body by id, with a configurable length limit. |
| `create_draft` | Opens a visible, unsent outgoing message. |
| `send_email` | Hands an approved message to Apple Mail for delivery. |
| `create_reply_draft` | Opens a visible reply draft and preserves Apple Mail's reply recipient/subject handling. |
| `set_message_read_status` | Marks one approved message read or unread. |
| `set_message_flag_status` | Flags or unflags one approved message. |
| `move_message` | Moves one approved message to another mailbox. |
| `get_audit_log` | Reads the local metadata-only audit trail. |
| `get_send_policy` / `preview_send` | Inspects or validates the active send safeguards without delivery. |
| `queue_email_for_approval` / `list_approval_queue` | Stores proposed emails locally for human review. |
| `approve_queued_email` / `discard_queued_email` | Applies an explicitly approved queue decision. |
| `save_contact_context` / `get_contact_context` | Maintains private relationship notes, tone, commitments, and follow-up dates. |
| `get_contact_brief` | Combines a saved contact profile with recent inbox summaries. |
| `list_follow_up_radar` | Surfaces saved contacts that are due for a human-approved follow-up. |
| `get_work_mode` / `set_work_mode` | Switches between focused policies such as inbox zero, sales follow-up, support, and deep work. |
| `save_thread_summary` | Saves a user-approved local thread summary with its source message ids. |
| `get_daily_briefing` | Combines unread messages, pending approvals, and due follow-ups into a safe daily action brief. |

## Scope and non-goals

This project is local-only. It is not an SMTP server, does not manage credentials, and does not bypass macOS privacy prompts. It deliberately excludes deletion, attachment export, background scheduling, and automatic sending.

## Publishing and registry metadata

The package is published as `@jakobf1/apple-mail-mcp`. Its MCP Registry identity is `io.github.jakobfigur/apple-mail-mcp`; see [`server.json`](server.json) for portable install metadata.

## License

MIT
