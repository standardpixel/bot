const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");

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

// Check if Obsidian is running and has a vault open
function ensureObsidianReady() {
  try {
    const result = execSync('pgrep -x obsidian', { encoding: 'utf8' }).trim();
    if (!result) {
      console.log('[briefing] Obsidian is not running, attempting to open vault...');
      // Open the vault directly using obsidian:// URI
      // This both opens Obsidian and ensures the vault is loaded
      const vaultName = 'evg'; // Extract from VAULT path
      execSync(`open "obsidian://open?vault=${encodeURIComponent(vaultName)}"`, { timeout: 10000 });
      // Wait 8 seconds for Obsidian and vault to load
      execSync('sleep 8');
      console.log('[briefing] Obsidian opened with vault');
      return true;
    }

    // Obsidian is running, but make sure vault is open
    console.log('[briefing] Obsidian is running, ensuring vault is open...');
    const vaultName = 'evg';
    try {
      execSync(`open "obsidian://open?vault=${encodeURIComponent(vaultName)}"`, { timeout: 5000 });
      // Give it a moment to switch vaults if needed
      execSync('sleep 2');
    } catch (e) {
      // Vault might already be open, that's okay
      console.log('[briefing] Vault switch attempted');
    }

    return true;
  } catch (err) {
    console.error('[briefing] Failed to ensure Obsidian is ready:', err.message);
    return false;
  }
}

// Trigger the briefing plugin using Obsidian CLI.
// Much more reliable than AppleScript, especially when system has been idle.
function triggerBriefingPlugin() {
  // Ensure Obsidian is running with vault open
  if (!ensureObsidianReady()) {
    throw new Error('Could not start Obsidian or open vault');
  }

  const commandId = "briefing-notes:generate-briefing-auto";
  // Use full path to obsidian binary to avoid PATH issues in Node.js processes
  const obsidianBin = "/Applications/Obsidian.app/Contents/MacOS/obsidian";

  try {
    // Use correct CLI syntax: code= parameter
    // Redirect stderr to suppress Obsidian's verbose logging (update checks, etc)
    const result = execSync(
      `"${obsidianBin}" eval code="app.commands.executeCommandById('${commandId}')" 2>/dev/null`,
      {
        encoding: 'utf8',
        timeout: 30000,
        shell: "/bin/bash",
      }
    ).trim();

    console.log(`[briefing] CLI command executed, result: ${result}`);

    // The command should return "true" if successful
    if (!result.includes('true')) {
      console.warn(`[briefing] Unexpected CLI result: ${result}`);
    }
  } catch (err) {
    // Even if there's stderr noise, the command might have worked
    console.log('[briefing] CLI command executed (ignoring stderr)');
  }
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

  // Start caffeinate to prevent system sleep during briefing generation
  // This ensures network connections and apps stay awake even if computer has been idle
  const caffeinate = spawn('caffeinate');
  console.log('[briefing] Started caffeinate to prevent system sleep');

  try {
    // Retry the trigger up to 3 times if file isn't created
    // This handles cases where CLI command fails on idle systems or Obsidian is slow to respond
    let triggerAttempts = 0;
    const MAX_TRIGGER_ATTEMPTS = 3;

    while (triggerAttempts < MAX_TRIGGER_ATTEMPTS) {
      triggerAttempts++;
      console.log(`[briefing] Trigger attempt ${triggerAttempts}/${MAX_TRIGGER_ATTEMPTS}`);

      try {
        triggerBriefingPlugin();
      } catch (err) {
        console.error(`[briefing] CLI trigger error on attempt ${triggerAttempts}:`, err.message);
        if (triggerAttempts < MAX_TRIGGER_ATTEMPTS) {
          console.log('[briefing] Waiting 10 seconds before retry...');
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        return `Failed to trigger briefing plugin after ${MAX_TRIGGER_ATTEMPTS} attempts. Error: ${err.message}\n\nMake sure:\n• Obsidian is running\n• Obsidian CLI is enabled (Settings → General → Command line interface)\n• The briefing-notes plugin is installed and enabled`;
      }

      // Wait up to 30 seconds for file to be created (indicates plugin started)
      let fileCheckAttempts = 0;
      while (fileCheckAttempts < 6 && !fs.existsSync(briefingPath)) {
        await new Promise((r) => setTimeout(r, 5000));
        fileCheckAttempts++;
      }

      // If file exists, break out and proceed with polling
      if (fs.existsSync(briefingPath)) {
        console.log('[briefing] File created, plugin started successfully');
        break;
      }

      // File doesn't exist after 30 seconds
      console.warn(`[briefing] File not created after trigger attempt ${triggerAttempts}`);

      if (triggerAttempts < MAX_TRIGGER_ATTEMPTS) {
        console.log('[briefing] Retrying trigger in 10 seconds...');
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        return `Briefing file was never created after ${MAX_TRIGGER_ATTEMPTS} trigger attempts. The Obsidian plugin may not be responding.\n\nThis often happens when the computer has been idle. Try:\n1. Manually opening Obsidian\n2. Running the briefing command manually once\n3. Asking me to try again`;
      }
    }

    // Poll every 5 seconds until complete or timeout (20 minutes to allow for slow connectors)
    const POLL_MS = 5000;
    const TIMEOUT_MS = 20 * 60 * 1000;
    const started = Date.now();

    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));

      if (!fs.existsSync(briefingPath)) {
        console.warn('[briefing] File disappeared during polling');
        continue;
      }

      const content = fs.readFileSync(briefingPath, "utf-8");

      if (content.includes("**Error:**")) {
        return `Briefing generation failed:\n\n${content}`;
      }

      if (isComplete(content)) {
        console.log('[briefing] Briefing completed successfully');
        return content;
      }
    }

    return "Briefing generation timed out after 20 minutes. The plugin may be stuck.";
  } finally {
    // Always kill caffeinate when done, whether successful or not
    caffeinate.kill();
    console.log('[briefing] Stopped caffeinate');
  }
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
