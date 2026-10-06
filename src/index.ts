#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 20_000;
const FIELD_SEPARATOR = "\u001f";
const AUDIT_LOG_PATH = process.env.APPLE_MAIL_MCP_AUDIT_LOG ?? resolve(homedir(), ".apple-mail-mcp", "audit.jsonl");
const DATA_STORE_PATH = process.env.APPLE_MAIL_MCP_DATA_STORE ?? resolve(homedir(), ".apple-mail-mcp", "data.json");
const ALLOWED_SENDERS = new Set(
  (process.env.APPLE_MAIL_MCP_ALLOWED_SENDERS ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean),
);
const ALLOWED_RECIPIENTS = new Set(
  (process.env.APPLE_MAIL_MCP_ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean),
);
const ALLOWED_RECIPIENT_DOMAINS = new Set(
  (process.env.APPLE_MAIL_MCP_ALLOWED_RECIPIENT_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),
);
const DRY_RUN = process.env.APPLE_MAIL_MCP_DRY_RUN === "true";
const SENDING_WINDOW = process.env.APPLE_MAIL_MCP_SENDING_WINDOW;

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

const createReplyDraftScript = `
on run argv
  set accountName to item 1 of argv
  set mailboxName to item 2 of argv
  set wantedId to item 3 of argv
  set replyText to item 4 of argv
  tell application "Mail"
    set targetAccount to account accountName
    set targetMailbox to mailbox mailboxName of targetAccount
    repeat with currentMessage in messages of targetMailbox
      if ((id of currentMessage) as text) is wantedId then
        set replyMessage to reply currentMessage with opening window
        set content of replyMessage to replyText & return & return & (content of replyMessage)
        return "Reply draft opened in Apple Mail."
      end if
    end repeat
  end tell
  error "No message with that id exists in the selected mailbox."
end run`;

const setReadStatusScript = `
on run argv
  set accountName to item 1 of argv
  set mailboxName to item 2 of argv
  set wantedId to item 3 of argv
  set desiredReadStatus to (item 4 of argv) as boolean
  tell application "Mail"
    set targetAccount to account accountName
    set targetMailbox to mailbox mailboxName of targetAccount
    repeat with currentMessage in messages of targetMailbox
      if ((id of currentMessage) as text) is wantedId then
        set read status of currentMessage to desiredReadStatus
        return "Message read status updated."
      end if
    end repeat
  end tell
  error "No message with that id exists in the selected mailbox."
end run`;

const setFlagStatusScript = `
on run argv
  set accountName to item 1 of argv
  set mailboxName to item 2 of argv
  set wantedId to item 3 of argv
  set desiredFlagStatus to (item 4 of argv) as boolean
  tell application "Mail"
    set targetAccount to account accountName
    set targetMailbox to mailbox mailboxName of targetAccount
    repeat with currentMessage in messages of targetMailbox
      if ((id of currentMessage) as text) is wantedId then
        set flagged status of currentMessage to desiredFlagStatus
        return "Message flag status updated."
      end if
    end repeat
  end tell
  error "No message with that id exists in the selected mailbox."
end run`;

const moveMessageScript = `
on run argv
  set accountName to item 1 of argv
  set sourceMailboxName to item 2 of argv
  set destinationMailboxName to item 3 of argv
  set wantedId to item 4 of argv
  tell application "Mail"
    set targetAccount to account accountName
    set sourceMailbox to mailbox sourceMailboxName of targetAccount
    set destinationMailbox to mailbox destinationMailboxName of targetAccount
    repeat with currentMessage in messages of sourceMailbox
      if ((id of currentMessage) as text) is wantedId then
        move currentMessage to destinationMailbox
        return "Message moved."
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

function assertAllowedSender(from: string | undefined): void {
  if (ALLOWED_SENDERS.size > 0 && (!from || !ALLOWED_SENDERS.has(from.toLowerCase()))) {
    throw new Error("This sender is not permitted by APPLE_MAIL_MCP_ALLOWED_SENDERS.");
  }
}

function checkSendPolicy(to: string, from: string | undefined): string[] {
  const issues: string[] = [];
  try {
    assertAllowedSender(from);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const normalizedTo = to.toLowerCase();
  const recipientDomain = normalizedTo.split("@")[1] ?? "";
  if (ALLOWED_RECIPIENTS.size > 0 && !ALLOWED_RECIPIENTS.has(normalizedTo)) {
    issues.push("This recipient is not permitted by APPLE_MAIL_MCP_ALLOWED_RECIPIENTS.");
  }
  if (ALLOWED_RECIPIENT_DOMAINS.size > 0 && !ALLOWED_RECIPIENT_DOMAINS.has(recipientDomain)) {
    issues.push("This recipient domain is not permitted by APPLE_MAIL_MCP_ALLOWED_RECIPIENT_DOMAINS.");
  }
  if (SENDING_WINDOW && !isWithinSendingWindow(SENDING_WINDOW)) {
    issues.push(`Sending is currently outside APPLE_MAIL_MCP_SENDING_WINDOW (${SENDING_WINDOW}).`);
  }
  return issues;
}

function isWithinSendingWindow(window: string): boolean {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!match) return false;
  const [, startHour, startMinute, endHour, endMinute] = match;
  const start = Number(startHour) * 60 + Number(startMinute);
  const end = Number(endHour) * 60 + Number(endMinute);
  if (start > 1439 || end > 1439) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

async function writeAudit(action: string, fields: Record<string, string | boolean | number | undefined>): Promise<void> {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), action, ...fields });
  await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
  await appendFile(AUDIT_LOG_PATH, `${entry}\n`, "utf8");
}

type ApprovalStatus = "pending" | "completed" | "discarded";
type WorkMode = "general" | "inbox_zero" | "sales_follow_up" | "support" | "deep_work";

type ApprovalItem = {
  id: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  to: string;
  from?: string;
  subject: string;
  text: string;
  note?: string;
  intent?: string;
  rationale?: string;
  tone?: string;
  risks: string[];
  sourceMessageIds: string[];
};

type ContactTimelineEntry = {
  at: string;
  summary: string;
  direction: "inbound" | "outbound" | "note";
};

type ThreadSummary = {
  createdAt: string;
  summary: string;
  sourceMessageIds: string[];
};

type ContactContext = {
  email: string;
  displayName?: string;
  relationship?: string;
  tone?: string;
  preferredLanguage?: string;
  notes: string[];
  openCommitments: string[];
  followUpAt?: string;
  timeline: ContactTimelineEntry[];
  threadSummaries: ThreadSummary[];
  updatedAt: string;
};

type LocalState = {
  version: 1;
  approvals: ApprovalItem[];
  contacts: Record<string, ContactContext>;
  workMode: WorkMode;
};

const EMPTY_STATE: LocalState = { version: 1, approvals: [], contacts: {}, workMode: "general" };

async function readState(): Promise<LocalState> {
  try {
    const parsed = JSON.parse(await readFile(DATA_STORE_PATH, "utf8")) as Partial<LocalState>;
    return {
      version: 1,
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      contacts: parsed.contacts && typeof parsed.contacts === "object" ? parsed.contacts : {},
      workMode: isWorkMode(parsed.workMode) ? parsed.workMode : "general",
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
    throw error;
  }
}

function isWorkMode(value: unknown): value is WorkMode {
  return value === "general" || value === "inbox_zero" || value === "sales_follow_up" || value === "support" || value === "deep_work";
}

function assertWorkModeAllows(mode: WorkMode, action: "queue" | "draft" | "send"): void {
  const allowed: Record<WorkMode, Array<"queue" | "draft" | "send">> = {
    general: ["queue", "draft", "send"],
    inbox_zero: ["queue", "draft"],
    sales_follow_up: ["queue", "draft", "send"],
    support: ["queue", "draft", "send"],
    deep_work: [],
  };
  if (!allowed[mode].includes(action)) {
    throw new Error(`The active ${mode} work mode does not permit ${action} actions through MCP.`);
  }
}

async function writeState(state: LocalState): Promise<void> {
  await mkdir(dirname(DATA_STORE_PATH), { recursive: true });
  const temporaryPath = `${DATA_STORE_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, DATA_STORE_PATH);
}

function statePathHint(): string {
  return DATA_STORE_PATH.replace(homedir(), "~");
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
    assertAllowedSender(from);
    const state = await readState();
    assertWorkModeAllows(state.workMode, "draft");
    const output = await appleScript(createDraftScript, [to, from ?? "", subject, text]);
    await writeAudit("create_draft", { to, from, subjectLength: subject.length, bodyLength: text.length });
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
    const state = await readState();
    assertWorkModeAllows(state.workMode, "send");
    const policyIssues = checkSendPolicy(to, from);
    if (policyIssues.length > 0) throw new Error(`Email was not sent: ${policyIssues.join(" ")}`);
    if (DRY_RUN) {
      await writeAudit("send_email_dry_run", { to, from, subjectLength: subject.length, bodyLength: text.length });
      return textResult("Dry-run enabled: email was validated but not sent.");
    }
    const output = await appleScript(sendMessageScript, [to, from ?? "", subject, text]);
    await writeAudit("send_email", { to, from, subjectLength: subject.length, bodyLength: text.length });
    return textResult(output);
  },
);

server.tool(
  "create_reply_draft",
  "Open a visible reply draft for an existing message. The original message controls the recipient and subject. This does not send anything.",
  {
    account: z.string().min(1).describe("Apple Mail account name."),
    mailbox: z.string().min(1).default("INBOX").describe("Mailbox containing the original message."),
    message_id: z.string().min(1).describe("Message id returned by list_messages or search_messages."),
    text: z.string().min(1).describe("Reply text to place above Apple Mail's quoted original message."),
  },
  async ({ account, mailbox, message_id, text }) => {
    const state = await readState();
    assertWorkModeAllows(state.workMode, "draft");
    const output = await appleScript(createReplyDraftScript, [account, mailbox, message_id, text]);
    await writeAudit("create_reply_draft", { account, mailbox, messageId: message_id, bodyLength: text.length });
    return textResult(output);
  },
);

const approvedMessageActionShape = {
  account: z.string().min(1).describe("Apple Mail account name."),
  mailbox: z.string().min(1).default("INBOX").describe("Mailbox containing the message."),
  message_id: z.string().min(1).describe("Message id returned by list_messages or search_messages."),
  user_approved: z.literal(true).describe("Must be true only after the user explicitly approved this exact action."),
};

server.tool(
  "set_message_read_status",
  "Mark a message read or unread. Only call after the user explicitly approved this exact action.",
  { ...approvedMessageActionShape, is_read: z.boolean().describe("True to mark read; false to mark unread.") },
  async ({ account, mailbox, message_id, is_read }) => {
    const output = await appleScript(setReadStatusScript, [account, mailbox, message_id, String(is_read)]);
    await writeAudit("set_message_read_status", { account, mailbox, messageId: message_id, isRead: is_read });
    return textResult(output);
  },
);

server.tool(
  "set_message_flag_status",
  "Flag or unflag a message. Only call after the user explicitly approved this exact action.",
  { ...approvedMessageActionShape, is_flagged: z.boolean().describe("True to flag; false to remove the flag.") },
  async ({ account, mailbox, message_id, is_flagged }) => {
    const output = await appleScript(setFlagStatusScript, [account, mailbox, message_id, String(is_flagged)]);
    await writeAudit("set_message_flag_status", { account, mailbox, messageId: message_id, isFlagged: is_flagged });
    return textResult(output);
  },
);

server.tool(
  "move_message",
  "Move a message to another mailbox in the same account. Only call after the user explicitly approved this exact action.",
  {
    ...approvedMessageActionShape,
    destination_mailbox: z.string().min(1).describe("Destination mailbox name, as returned by list_mailboxes."),
  },
  async ({ account, mailbox, message_id, destination_mailbox }) => {
    const output = await appleScript(moveMessageScript, [account, mailbox, destination_mailbox, message_id]);
    await writeAudit("move_message", { account, sourceMailbox: mailbox, destinationMailbox: destination_mailbox, messageId: message_id });
    return textResult(output);
  },
);

server.tool(
  "get_audit_log",
  "Read recent local audit metadata for write actions. Email bodies are never stored in this log.",
  { limit: z.number().int().min(1).max(200).default(50).describe("Maximum recent audit entries to return.") },
  async ({ limit }) => {
    try {
      const output = await readFile(AUDIT_LOG_PATH, "utf8");
      const entries = output.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
      return textResult(JSON.stringify(entries, null, 2));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return textResult("No local audit log exists yet.");
      throw error;
    }
  },
);

server.tool(
  "get_send_policy",
  "Show the active local sending safeguards without exposing credentials. Read-only.",
  {},
  async () =>
    textResult(
      JSON.stringify(
        {
          dryRun: DRY_RUN,
          senderAllowlistEnabled: ALLOWED_SENDERS.size > 0,
          recipientAllowlistEnabled: ALLOWED_RECIPIENTS.size > 0,
          recipientDomainAllowlistEnabled: ALLOWED_RECIPIENT_DOMAINS.size > 0,
          sendingWindow: SENDING_WINDOW ?? null,
          auditLog: AUDIT_LOG_PATH.replace(homedir(), "~"),
        },
        null,
        2,
      ),
    ),
);

server.tool(
  "preview_send",
  "Validate a proposed email against the active local send policy without creating or sending anything. Read-only.",
  {
    to: z.string().email(),
    from: z.string().email().optional(),
    subject: z.string().min(1).max(300),
    text: z.string().min(1),
  },
  async ({ to, from, subject, text }) => {
    const issues = checkSendPolicy(to, from);
    return textResult(
      JSON.stringify(
        {
          permitted: issues.length === 0,
          dryRun: DRY_RUN,
          to,
          from: from ?? null,
          subjectLength: subject.length,
          bodyLength: text.length,
          issues,
        },
        null,
        2,
      ),
    );
  },
);

server.tool(
  "queue_email_for_approval",
  "Save a proposed email in the local approval inbox. It does not create a Mail draft or send anything.",
  {
    to: z.string().email(),
    from: z.string().email().optional(),
    subject: z.string().min(1).max(300),
    text: z.string().min(1),
    note: z.string().max(1_000).optional().describe("Optional human-facing note."),
    intent: z.string().max(500).optional().describe("Desired outcome, such as booking a discovery call or resolving a support request."),
    rationale: z.string().max(2_000).optional().describe("Why this action and timing are appropriate, grounded in known context."),
    tone: z.string().max(500).optional().describe("Proposed tone, such as concise and collaborative."),
    risks: z.array(z.string().min(1).max(1_000)).max(10).default([]).describe("Known uncertainties or reasons to review carefully."),
    source_message_ids: z.array(z.string().min(1)).max(30).default([]).describe("Message ids used as evidence for the proposal."),
  },
  async ({ to, from, subject, text, note, intent, rationale, tone, risks, source_message_ids }) => {
    assertAllowedSender(from);
    const state = await readState();
    assertWorkModeAllows(state.workMode, "queue");
    const now = new Date().toISOString();
    const item: ApprovalItem = {
      id: randomUUID(), status: "pending", createdAt: now, updatedAt: now, to, from, subject, text, note, intent, rationale, tone, risks, sourceMessageIds: source_message_ids,
    };
    state.approvals.push(item);
    await writeState(state);
    await writeAudit("queue_email_for_approval", { itemId: item.id, to, from, subjectLength: subject.length, bodyLength: text.length });
    return textResult(JSON.stringify({ id: item.id, status: item.status, storedAt: statePathHint() }, null, 2));
  },
);

server.tool(
  "list_approval_queue",
  "List proposed emails in the local approval inbox. Read-only.",
  {
    status: z.enum(["pending", "completed", "discarded", "all"]).default("pending"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ status, limit }) => {
    const state = await readState();
    const items = state.approvals
      .filter((item) => status === "all" || item.status === status)
      .slice(-limit)
      .map(({ text, risks = [], sourceMessageIds = [], ...item }) => ({ ...item, risks, sourceMessageIds, bodyLength: text.length }));
    return textResult(JSON.stringify(items, null, 2));
  },
);

server.tool(
  "approve_queued_email",
  "Turn one pending approval-queue item into a visible draft or send it. Only call after the user explicitly approved this exact item and delivery mode.",
  {
    item_id: z.string().uuid(),
    delivery: z.enum(["draft", "send"]).describe("Create a visible draft or send the approved item."),
    user_approved: z.literal(true).describe("Must be true only after the user explicitly approved this exact queue item and delivery mode."),
  },
  async ({ item_id, delivery }) => {
    const state = await readState();
    const item = state.approvals.find((candidate) => candidate.id === item_id);
    if (!item) throw new Error("No approval item with that id exists.");
    if (item.status !== "pending") throw new Error(`Approval item is already ${item.status}.`);

    if (delivery === "send") {
      assertWorkModeAllows(state.workMode, "send");
      const issues = checkSendPolicy(item.to, item.from);
      if (issues.length > 0) throw new Error(`Email was not sent: ${issues.join(" ")}`);
      if (DRY_RUN) {
        await writeAudit("approve_queued_email_dry_run", { itemId: item.id, to: item.to, from: item.from });
        return textResult("Dry-run enabled: queue item remains pending and was not sent.");
      }
      await appleScript(sendMessageScript, [item.to, item.from ?? "", item.subject, item.text]);
    } else {
      assertWorkModeAllows(state.workMode, "draft");
      assertAllowedSender(item.from);
      await appleScript(createDraftScript, [item.to, item.from ?? "", item.subject, item.text]);
    }

    item.status = "completed";
    item.updatedAt = new Date().toISOString();
    await writeState(state);
    await writeAudit("approve_queued_email", { itemId: item.id, delivery, to: item.to, from: item.from });
    return textResult(delivery === "send" ? "Approved email handed to Apple Mail for delivery." : "Approved email opened as a visible Apple Mail draft.");
  },
);

server.tool(
  "discard_queued_email",
  "Discard one pending approval-queue item. It will not affect Apple Mail. Only call after explicit user approval.",
  { item_id: z.string().uuid(), user_approved: z.literal(true) },
  async ({ item_id }) => {
    const state = await readState();
    const item = state.approvals.find((candidate) => candidate.id === item_id);
    if (!item) throw new Error("No approval item with that id exists.");
    if (item.status !== "pending") throw new Error(`Approval item is already ${item.status}.`);
    item.status = "discarded";
    item.updatedAt = new Date().toISOString();
    await writeState(state);
    await writeAudit("discard_queued_email", { itemId: item.id, to: item.to, from: item.from });
    return textResult("Approval item discarded. Apple Mail was not changed.");
  },
);

const contactShape = {
  email: z.string().email(),
  display_name: z.string().max(200).optional(),
  relationship: z.string().max(500).optional().describe("For example: prospect, client, partner, or colleague."),
  tone: z.string().max(500).optional().describe("For example: concise and direct, or warm and detailed."),
  preferred_language: z.string().max(100).optional(),
  notes: z.array(z.string().min(1).max(2_000)).max(30).default([]),
  open_commitments: z.array(z.string().min(1).max(2_000)).max(30).default([]),
  follow_up_at: z.string().datetime().optional().describe("ISO-8601 date/time for a human-approved follow-up reminder."),
};

server.tool(
  "save_contact_context",
  "Save local relationship context for one contact. This does not modify Apple Mail or contact the person.",
  {
    ...contactShape,
    timeline_summary: z.string().max(2_000).optional(),
    timeline_direction: z.enum(["inbound", "outbound", "note"]).default("note"),
    user_approved: z.literal(true).describe("Must be true only after the user approved saving this local contact context."),
  },
  async ({ email, display_name, relationship, tone, preferred_language, notes, open_commitments, follow_up_at, timeline_summary, timeline_direction }) => {
    const state = await readState();
    const key = email.toLowerCase();
    const existing = state.contacts[key];
    const timeline = existing?.timeline ?? [];
    if (timeline_summary) timeline.push({ at: new Date().toISOString(), summary: timeline_summary, direction: timeline_direction });
    state.contacts[key] = {
      email: key,
      displayName: display_name ?? existing?.displayName,
      relationship: relationship ?? existing?.relationship,
      tone: tone ?? existing?.tone,
      preferredLanguage: preferred_language ?? existing?.preferredLanguage,
      notes: notes.length > 0 ? notes : existing?.notes ?? [],
      openCommitments: open_commitments.length > 0 ? open_commitments : existing?.openCommitments ?? [],
      followUpAt: follow_up_at ?? existing?.followUpAt,
      timeline: timeline.slice(-50),
      threadSummaries: existing?.threadSummaries ?? [],
      updatedAt: new Date().toISOString(),
    };
    await writeState(state);
    await writeAudit("save_contact_context", { email: key, timelineAdded: Boolean(timeline_summary) });
    return textResult(JSON.stringify({ email: key, storedAt: statePathHint() }, null, 2));
  },
);

server.tool(
  "get_contact_context",
  "Read the local relationship context for one email address. Read-only.",
  { email: z.string().email() },
  async ({ email }) => {
    const state = await readState();
    const contact = state.contacts[email.toLowerCase()];
    return textResult(JSON.stringify(contact ?? { email: email.toLowerCase(), exists: false }, null, 2));
  },
);

server.tool(
  "get_contact_brief",
  "Build a local contact brief from saved relationship context and recent inbox summaries. Read-only; message bodies are excluded.",
  {
    email: z.string().email(),
    account: z.string().min(1),
    mailbox: z.string().min(1).default("INBOX"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ email, account, mailbox, limit }) => {
    const state = await readState();
    const output = await appleScript(searchMessagesScript, [account, mailbox, email, String(limit), "500"]);
    return textResult(
      JSON.stringify(
        { context: state.contacts[email.toLowerCase()] ?? null, recentMessages: parseMessageSummaries(output) },
        null,
        2,
      ),
    );
  },
);

server.tool(
  "list_follow_up_radar",
  "List local contact records with a follow-up date due now or within a chosen horizon. Read-only; it never sends anything.",
  { within_days: z.number().int().min(0).max(365).default(7) },
  async ({ within_days }) => {
    const state = await readState();
    const deadline = new Date(Date.now() + within_days * 24 * 60 * 60 * 1000);
    const contacts = Object.values(state.contacts)
      .filter((contact) => contact.followUpAt && new Date(contact.followUpAt) <= deadline)
      .sort((left, right) => (left.followUpAt ?? "").localeCompare(right.followUpAt ?? ""));
    return textResult(JSON.stringify(contacts, null, 2));
  },
);

server.tool(
  "get_work_mode",
  "Show the active local AI-mail work mode and its allowed MCP actions. Read-only.",
  {},
  async () => {
    const state = await readState();
    const permissions: Record<WorkMode, string[]> = {
      general: ["queue", "draft", "send"],
      inbox_zero: ["queue", "draft"],
      sales_follow_up: ["queue", "draft", "send"],
      support: ["queue", "draft", "send"],
      deep_work: [],
    };
    return textResult(JSON.stringify({ mode: state.workMode, allowedActions: permissions[state.workMode] }, null, 2));
  },
);

server.tool(
  "set_work_mode",
  "Set the local AI-mail work mode. The mode controls whether this MCP may queue, draft, or send. This does not change Apple Mail.",
  {
    mode: z.enum(["general", "inbox_zero", "sales_follow_up", "support", "deep_work"]),
    user_approved: z.literal(true).describe("Must be true only after the user explicitly approved the mode change."),
  },
  async ({ mode }) => {
    const state = await readState();
    state.workMode = mode;
    await writeState(state);
    await writeAudit("set_work_mode", { mode });
    return textResult(`Work mode set to ${mode}.`);
  },
);

server.tool(
  "save_thread_summary",
  "Save a local, user-approved summary of a selected contact thread, including the exact source message ids used. It does not modify Apple Mail.",
  {
    email: z.string().email(),
    summary: z.string().min(1).max(8_000),
    source_message_ids: z.array(z.string().min(1)).min(1).max(50),
    user_approved: z.literal(true).describe("Must be true only after the user approved saving this local thread summary."),
  },
  async ({ email, summary, source_message_ids }) => {
    const state = await readState();
    const key = email.toLowerCase();
    const existing = state.contacts[key];
    const threadSummaries = [...(existing?.threadSummaries ?? []), { createdAt: new Date().toISOString(), summary, sourceMessageIds: source_message_ids }].slice(-20);
    state.contacts[key] = {
      email: key,
      displayName: existing?.displayName,
      relationship: existing?.relationship,
      tone: existing?.tone,
      preferredLanguage: existing?.preferredLanguage,
      notes: existing?.notes ?? [],
      openCommitments: existing?.openCommitments ?? [],
      followUpAt: existing?.followUpAt,
      timeline: existing?.timeline ?? [],
      threadSummaries,
      updatedAt: new Date().toISOString(),
    };
    await writeState(state);
    await writeAudit("save_thread_summary", { email: key, sourceCount: source_message_ids.length, summaryLength: summary.length });
    return textResult(JSON.stringify({ email: key, summaryCount: threadSummaries.length, storedAt: statePathHint() }, null, 2));
  },
);

server.tool(
  "get_daily_briefing",
  "Create a read-only daily briefing from one inbox, the local approval queue, and saved follow-up dates. It never drafts, sends, or changes email.",
  {
    account: z.string().min(1).describe("Apple Mail account name."),
    mailbox: z.string().min(1).default("INBOX"),
    unread_limit: z.number().int().min(1).max(50).default(10),
    follow_up_days: z.number().int().min(0).max(30).default(7),
  },
  async ({ account, mailbox, unread_limit, follow_up_days }) => {
    const state = await readState();
    const unreadOutput = await appleScript(listMessagesScript, [account, mailbox, String(unread_limit), "true"]);
    const deadline = new Date(Date.now() + follow_up_days * 24 * 60 * 60 * 1000);
    const followUps = Object.values(state.contacts)
      .filter((contact) => contact.followUpAt && new Date(contact.followUpAt) <= deadline)
      .sort((left, right) => (left.followUpAt ?? "").localeCompare(right.followUpAt ?? ""));
    const pending = state.approvals.filter((item) => item.status === "pending");
    const recommendedNextSteps: string[] = [];
    if (pending.length > 0) recommendedNextSteps.push(`Review ${pending.length} approval-queue item${pending.length === 1 ? "" : "s"}.`);
    if (followUps.length > 0) recommendedNextSteps.push(`Review ${followUps.length} follow-up${followUps.length === 1 ? "" : "s"} due within ${follow_up_days} day${follow_up_days === 1 ? "" : "s"}.`);
    if (parseMessageSummaries(unreadOutput).length > 0) recommendedNextSteps.push("Review unread messages and decide whether to draft, queue, or defer.");
    if (recommendedNextSteps.length === 0) recommendedNextSteps.push("No queued approvals, due follow-ups, or unread messages were found in this briefing scope.");

    return textResult(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          workMode: state.workMode,
          inbox: { account, mailbox, unreadMessages: parseMessageSummaries(unreadOutput) },
          approvalQueue: pending.map(({ text, ...item }) => ({ ...item, bodyLength: text.length })),
          followUps,
          recommendedNextSteps,
        },
        null,
        2,
      ),
    );
  },
);

await server.connect(new StdioServerTransport());
