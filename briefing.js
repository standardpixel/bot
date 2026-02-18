const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const rawVault = (process.env.OBSIDIAN_VAULT_PATH || "").replace(/\\(.)/g, "$1");
const VAULT = rawVault.startsWith("~") ? path.join(os.homedir(), rawVault.slice(1)) : rawVault;

// Read briefingFolder from the plugin's own settings so it stays in sync
function getBriefingFolder() {
  try {
    const dataJson = path.join(VAULT, ".obsidian", "plugins", "briefing-notes", "data.json");
    const settings = JSON.parse(fs.readFileSync(dataJson, "utf-8"));
    return settings.briefingFolder || "Briefings";
  } catch {
    return "Briefings";
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getBriefingPath() {
  return path.join(VAULT, getBriefingFolder(), `Briefing ${todayStr()}.md`);
}

// The plugin writes "Generating briefing..." during generation.
// When done it replaces ALL content with the final briefing.
// Only check for the specific in-progress string — not "## Status" which
// can legitimately appear in LLM-generated briefing content.
function isInProgress(content) {
  return (
    content.includes("Generating briefing...") ||
    content.includes("Gathering notes...") ||
    content.includes("Generating final briefing with LLM...")
  );
}

function isComplete(content) {
  return content.trim().length > 0 && !isInProgress(content);
}

// Trigger the auto command in Obsidian via the command palette using AppleScript.
// Requires Accessibility access for Terminal in System Settings → Privacy & Security.
function triggerBriefingPlugin() {
  const script = `
tell application "Obsidian"
  activate
end tell
delay 1
tell application "System Events"
  tell process "Obsidian"
    keystroke "p" using {command down}
    delay 0.5
    keystroke "Generate Briefing Note (Auto)"
    delay 0.5
    key code 36
  end tell
end tell
`;
  execSync(`osascript << 'OSASCRIPT'\n${script}\nOSASCRIPT`, {
    timeout: 15000,
    shell: "/bin/bash",
  });
}

async function runDailyBriefing() {
  const briefingPath = getBriefingPath();

  // Return existing complete briefing if already generated today
  if (fs.existsSync(briefingPath)) {
    const existing = fs.readFileSync(briefingPath, "utf-8");
    if (isComplete(existing)) {
      return `Today's briefing already exists:\n\n${existing}`;
    }
  }

  // Trigger the plugin
  triggerBriefingPlugin();

  // Poll every 5 seconds until complete or timeout (8 minutes to allow for slow connectors)
  const POLL_MS = 5000;
  const TIMEOUT_MS = 8 * 60 * 1000;
  const started = Date.now();

  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    if (!fs.existsSync(briefingPath)) continue;

    const content = fs.readFileSync(briefingPath, "utf-8");

    if (content.includes("**Error:**")) {
      return `Briefing generation failed:\n\n${content}`;
    }

    if (isComplete(content)) {
      return content;
    }
  }

  return "Briefing generation timed out after 8 minutes.";
}

const BRIEFING_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_daily_briefing",
      description:
        "Trigger the Obsidian briefing plugin to generate today's briefing using all connectors (mail, calendar, Slack). " +
        "If today's briefing is already complete it returns immediately. " +
        "Otherwise it triggers generation and waits — this can take several minutes. " +
        "The briefing is automatically saved to the vault by the plugin — NEVER call create_note or append_to_note with the returned content.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

async function executeBriefingTool(name) {
  switch (name) {
    case "run_daily_briefing":
      return await runDailyBriefing();
    default:
      throw new Error(`Unknown briefing tool: ${name}`);
  }
}

module.exports = { BRIEFING_TOOLS, executeBriefingTool };
