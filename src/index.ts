import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 20_000;

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

const server = new McpServer({
  name: "apple-mail-mcp",
  version: "0.1.0",
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
