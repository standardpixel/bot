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

// Check if Obsidian is running, and open it if not
function ensureObsidianRunning() {
  try {
    const result = execSync('pgrep -x Obsidian', { encoding: 'utf8' }).trim();
    if (result) {
      console.log('[briefing] Obsidian is running');
      return true;
    }
  } catch (err) {
    // pgrep returns exit code 1 if no process found
    console.log('[briefing] Obsidian is not running, attempting to open...');
    try {
      execSync('open -a Obsidian', { timeout: 10000 });
      // Wait 5 seconds for Obsidian to start
      execSync('sleep 5');
      console.log('[briefing] Obsidian opened');
      return true;
    } catch (openErr) {
      console.error('[briefing] Failed to open Obsidian:', openErr.message);
      return false;
    }
  }
  return true;
}

// Trigger the briefing plugin using Obsidian CLI.
// Much more reliable than AppleScript, especially when system has been idle.
// Requires Obsidian CLI to be enabled in Settings → General → Command line interface.
function triggerBriefingPlugin() {
  const commandId = "briefing-notes:generate-briefing-auto";

  // Ensure Obsidian is running
  if (!ensureObsidianRunning()) {
    throw new Error('Could not start Obsidian');
  }

  try {
    // Redirect stderr to /dev/null to ignore Obsidian's verbose logging
    // The CLI outputs a lot of informational messages to stderr that aren't errors
    execSync(`obsidian eval "app.commands.executeCommandById('${commandId}')" 2>/dev/null`, {
      timeout: 30000,
      shell: "/bin/bash",
      stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
    });
    console.log('[briefing] Successfully triggered briefing plugin via CLI');
  } catch (err) {
    // If the command fails but only because of stderr noise, it might have still worked
    // Check if it's a real error (exit code > 0 and not just stderr output)
    if (err.status && err.status !== 0 && !err.stderr) {
      throw new Error(`Obsidian CLI failed with exit code ${err.status}. Make sure Obsidian is running and the CLI is enabled.`);
    }
    // Otherwise, assume it worked despite the stderr noise
    console.log('[briefing] Obsidian CLI executed (ignoring stderr noise)');
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
