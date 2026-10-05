# Apple Mail MCP

A local, stdio-based [Model Context Protocol](https://modelcontextprotocol.io/) server for Apple Mail on macOS.

It is deliberately small: it talks only to the Apple Mail app already configured on the user's Mac. It does not need IMAP/SMTP passwords, open a network port, or send mailbox data to a third party.

## Safety model

- `list_accounts` is read-only.
- `create_draft` opens an unsent, visible draft in Apple Mail.
- `send_email` requires `user_approved: true`. MCP clients should call it only after the user has approved the exact message.
- Dynamic content is passed to `osascript` as arguments, not interpolated into AppleScript source.

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
| `create_draft` | Opens a visible, unsent outgoing message. |
| `send_email` | Hands an approved message to Apple Mail for delivery. |

## Scope and non-goals

This project is local-only. It is not an SMTP server, does not manage credentials, and does not bypass macOS privacy prompts. Inbox search and attachment tooling are intentionally out of scope for the first release, so the initial security surface stays small.

## License

MIT
