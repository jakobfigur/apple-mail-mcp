import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 20_000;
const FIELD_SEPARATOR = "\u001f";

function requireMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("apple-mail-mcp only runs on macOS.");
  }
}

/** Run an AppleScript and pass all dynamic content as argv, never as script code. */
async function appleScript(script: string, args: string[] = []): Promise<string> {
  requireMacOS();

  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      reject(
        new Error(
          `Apple Mail did not complete the request${code === null ? " (timed out)" : ` (exit ${code})`}: ${stderr.trim() || "No additional detail"}`,
        ),
      );
    });
  });
}

const listAccountsScript = `
tell application "Mail"
  set accountInfo to ""
  repeat with currentAccount in every account
    set accountInfo to accountInfo & (name of currentAccount) & tab & (email addresses of currentAccount as text) & linefeed
  end repeat
  return accountInfo
end tell`;

const listMailboxesScript = `
on run argv
  set accountName to item 1 of argv
  tell application "Mail"
    set targetAccount to account accountName
    set mailboxInfo to ""
    repeat with currentMailbox in mailboxes of targetAccount
      set mailboxInfo to mailboxInfo & (name of currentMailbox) & linefeed
    end repeat
    return mailboxInfo
  end tell
end run`;

const listMessagesScript = `
on run argv
  set accountName to item 1 of argv
  set mailboxName to item 2 of argv
  set maximumResults to (item 3 of argv) as integer
  set unreadOnly to (item 4 of argv) as boolean
  set fieldSeparator to character id 31
  tell application "Mail"
    set targetAccount to account accountName
    set targetMailbox to mailbox mailboxName of targetAccount
    set resultInfo to ""
    set resultCount to 0
    repeat with currentMessage in messages of targetMailbox
      if resultCount is less than maximumResults then
        if (not unreadOnly) or (read status of currentMessage is false) then
          set resultInfo to resultInfo & ((id of currentMessage) as text) & fieldSeparator & ((read status of currentMessage) as text) & fieldSeparator & (sender of currentMessage) & fieldSeparator & (subject of currentMessage) & fieldSeparator & ((date received of currentMessage) as text) & linefeed
          set resultCount to resultCount + 1
        end if
      end if
    end repeat
    return resultInfo
  end tell
end run`;

const searchMessagesScript = `
on run argv
  set accountName to item 1 of argv
  set mailboxName to item 2 of argv
  set queryText to item 3 of argv
  set maximumResults to (item 4 of argv) as integer
  set scanLimit to (item 5 of argv) as integer
  set fieldSeparator to character id 31
  tell application "Mail"
    set targetAccount to account accountName
    set targetMailbox to mailbox mailboxName of targetAccount
    set resultInfo to ""
    set resultCount to 0
    set scannedCount to 0
    repeat with currentMessage in messages of targetMailbox
      if scannedCount is less than scanLimit and resultCount is less than maximumResults then
        set scannedCount to scannedCount + 1
        set messageSubject to subject of currentMessage
        set messageSender to sender of currentMessage
        ignoring case
          if messageSubject contains queryText or messageSender contains queryText then
            set resultInfo to resultInfo & ((id of currentMessage) as text) & fieldSeparator & ((read status of currentMessage) as text) & fieldSeparator & messageSender & fieldSeparator & messageSubject & fieldSeparator & ((date received of currentMessage) as text) & linefeed
            set resultCount to resultCount + 1
          end if
        end ignoring
      end if
    end repeat
    return resultInfo
  end tell
end run`;

const getMessageScript = `
on run argv
  set accountName to item 1 of argv
  set mailboxName to item 2 of argv
  set wantedId to item 3 of argv
  set maximumBodyCharacters to (item 4 of argv) as integer
  set fieldSeparator to character id 31
  tell application "Mail"
    set targetAccount to account accountName
    set targetMailbox to mailbox mailboxName of targetAccount
    repeat with currentMessage in messages of targetMailbox
      if ((id of currentMessage) as text) is wantedId then
        set messageContent to content of currentMessage
        if (count of characters of messageContent) is greater than maximumBodyCharacters then
          set messageContent to (characters 1 through maximumBodyCharacters of messageContent) as text
          set messageContent to messageContent & "\n\n[Message body truncated by apple-mail-mcp.]"
        end if
        return ((id of currentMessage) as text) & fieldSeparator & (sender of currentMessage) & fieldSeparator & (subject of currentMessage) & fieldSeparator & ((date received of currentMessage) as text) & fieldSeparator & ((read status of currentMessage) as text) & fieldSeparator & messageContent
      end if
    end repeat
  end tell
  error "No message with that id exists in the selected mailbox."
end run`;

const createDraftScript = `
on run argv
  set recipientAddress to item 1 of argv
  set senderAddress to item 2 of argv
  set subjectLine to item 3 of argv
  set bodyText to item 4 of argv
  tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:subjectLine, content:bodyText, visible:true}
    tell newMessage
      if senderAddress is not "" then set sender to senderAddress
      make new to recipient at end of to recipients with properties {address:recipientAddress}
    end tell
  end tell
  return "Draft opened in Apple Mail."
end run`;

const sendMessageScript = `
on run argv
  set recipientAddress to item 1 of argv
  set senderAddress to item 2 of argv
  set subjectLine to item 3 of argv
  set bodyText to item 4 of argv
  tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:subjectLine, content:bodyText, visible:false}
    tell newMessage
      if senderAddress is not "" then set sender to senderAddress
      make new to recipient at end of to recipients with properties {address:recipientAddress}
      send
    end tell
  end tell
  return "Message handed to Apple Mail for delivery."
end run`;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

type MessageSummary = {
  id: string;
  read: boolean;
  sender: string;
  subject: string;
  receivedAt: string;
};

function parseMessageSummaries(output: string): MessageSummary[] {
  if (!output.trim()) return [];

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", read = "false", sender = "", subject = "", receivedAt = ""] = line.split(FIELD_SEPARATOR);
      return { id, read: read === "true", sender, subject, receivedAt };
    });
}

function parseMessageDetail(output: string) {
  const fields: string[] = [];
  let remainder = output;
  for (let index = 0; index < 5; index += 1) {
    const separatorIndex = remainder.indexOf(FIELD_SEPARATOR);
    if (separatorIndex < 0) throw new Error("Apple Mail returned an incomplete message record.");
    fields.push(remainder.slice(0, separatorIndex));
    remainder = remainder.slice(separatorIndex + FIELD_SEPARATOR.length);
  }
  const [id, sender, subject, receivedAt, read] = fields;
  return { id, sender, subject, receivedAt, read: read === "true", text: remainder };
}

const server = new McpServer({
  name: "apple-mail-mcp",
  version: "0.2.0",
});

server.tool(
  "list_accounts",
  "List Apple Mail accounts and their configured sender addresses. Read-only.",
  {},
  async () => {
    const output = await appleScript(listAccountsScript);
    return textResult(output || "No Apple Mail accounts were returned.");
  },
);

server.tool(
  "list_mailboxes",
  "List the top-level mailboxes in one Apple Mail account. Read-only.",
  { account: z.string().min(1).describe("Apple Mail account name, as returned by list_accounts.") },
  async ({ account }) => {
    const output = await appleScript(listMailboxesScript, [account]);
    return textResult(output || "No top-level mailboxes were returned.");
  },
);

const messageListShape = {
  account: z.string().min(1).describe("Apple Mail account name."),
  mailbox: z.string().min(1).default("INBOX").describe("Mailbox name. Usually INBOX."),
  limit: z.number().int().min(1).max(100).default(25).describe("Maximum number of messages to return."),
};

server.tool(
  "list_messages",
  "List message summaries from an Apple Mail mailbox. Read-only; bodies are not included.",
  { ...messageListShape, unread_only: z.boolean().default(false).describe("Return only unread messages.") },
  async ({ account, mailbox, limit, unread_only }) => {
    const output = await appleScript(listMessagesScript, [account, mailbox, String(limit), String(unread_only)]);
    return textResult(JSON.stringify(parseMessageSummaries(output), null, 2));
  },
);

server.tool(
  "search_messages",
  "Search recent messages by subject or sender in one mailbox. Read-only; bodies are not searched.",
  {
    ...messageListShape,
    query: z.string().min(1).max(200).describe("Case-insensitive text to match against sender or subject."),
    scan_limit: z.number().int().min(1).max(1000).default(300).describe("How many recent messages Apple Mail may inspect."),
  },
  async ({ account, mailbox, query, limit, scan_limit }) => {
    const output = await appleScript(searchMessagesScript, [account, mailbox, query, String(limit), String(scan_limit)]);
    return textResult(JSON.stringify(parseMessageSummaries(output), null, 2));
  },
);

server.tool(
  "get_message",
  "Read one message body by its id. Use after list_messages or search_messages. Read-only.",
  {
    account: z.string().min(1).describe("Apple Mail account name."),
    mailbox: z.string().min(1).default("INBOX").describe("Mailbox containing the message."),
    message_id: z.string().min(1).describe("Message id returned by list_messages or search_messages."),
    max_body_characters: z.number().int().min(500).max(50_000).default(12_000).describe("Maximum body characters to return."),
  },
  async ({ account, mailbox, message_id, max_body_characters }) => {
    const output = await appleScript(getMessageScript, [account, mailbox, message_id, String(max_body_characters)]);
    return textResult(JSON.stringify(parseMessageDetail(output), null, 2));
  },
);

server.tool(
  "create_draft",
  "Create a visible unsent draft in Apple Mail. Use this before sending whenever the user should review the message.",
  {
    to: z.string().email().describe("Recipient email address."),
    subject: z.string().min(1).max(300),
    text: z.string().min(1),
    from: z.string().email().optional().describe("Configured Apple Mail sender address, if a specific one is required."),
  },
  async ({ to, subject, text, from }) => {
    const output = await appleScript(createDraftScript, [to, from ?? "", subject, text]);
    return textResult(output);
  },
);

server.tool(
  "send_email",
  "Send an email using Apple Mail. Only call after the user explicitly approved this exact recipient, subject, and body.",
  {
    to: z.string().email().describe("Recipient email address."),
    subject: z.string().min(1).max(300),
    text: z.string().min(1),
    from: z.string().email().optional().describe("Configured Apple Mail sender address, if a specific one is required."),
    user_approved: z.literal(true).describe("Must be true only after the user explicitly approved this exact email."),
  },
  async ({ to, subject, text, from }) => {
    const output = await appleScript(sendMessageScript, [to, from ?? "", subject, text]);
    return textResult(output);
  },
);

await server.connect(new StdioServerTransport());
