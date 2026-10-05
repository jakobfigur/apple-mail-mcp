# Apple Mail MCP

A local, stdio-based [Model Context Protocol](https://modelcontextprotocol.io/) server for Apple Mail on macOS.

It talks only to the Apple Mail app already configured on the user's Mac. It does not need IMAP/SMTP passwords or open a network port.

## Safety model

- Mailbox and message tools are read-only by default.
- `create_draft` opens an unsent, visible draft in Apple Mail.
- `send_email` requires `user_approved: true`. MCP clients should call it only after the user has approved the exact message.
- Dynamic content is passed to `osascript` as arguments, not interpolated into AppleScript source.

The MCP server itself is local. However, an MCP client may send tool results to an AI model or another service. Only connect clients and models you trust with mail content.

## Requirements

- macOS with Apple Mail configured
- Node.js 20+
- Permission for the host application (for example Codex or Terminal) to control Mail under **System Settings → Privacy & Security → Automation**

## Install

```bash
git clone https://github.com/YOUR_ACCOUNT/apple-mail-mcp.git
cd apple-mail-mcp
npm install
npm run build
```

## Add to an MCP client

Use the compiled server over stdio:

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

## Scope and non-goals

This project is local-only. It is not an SMTP server, does not manage credentials, and does not bypass macOS privacy prompts. The initial release deliberately excludes deletion, archive, mailbox moves, attachment export, and automatic sending.

## License

MIT
