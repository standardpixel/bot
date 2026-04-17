const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/obsidian";
const VAULT_NAME = "evg";

const rawVault = (process.env.OBSIDIAN_VAULT_PATH || "").replace(/\\(.)/g, "$1");
const VAULT = rawVault.startsWith("~") ? path.join(os.homedir(), rawVault.slice(1)) : rawVault;

// Run an Obsidian CLI command
function runCli(command, options = {}) {
  const timeout = options.timeout || 30000;
  try {
    const result = execSync(`"${OBSIDIAN_BIN}" ${command} 2>/dev/null`, {
      encoding: "utf8",
      timeout,
      shell: "/bin/bash",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return result;
  } catch (err) {
    if (err.killed) {
      throw new Error(`CLI command timed out after ${timeout}ms`);
    }
    throw new Error(`CLI error: ${err.message}`);
  }
}

// Open a note and run entity linker via CLI eval (no focus required)
function runEntityLinkerOnNote(relativePath) {
  // Ensure .md extension
  const notePath = relativePath.endsWith(".md") ? relativePath : relativePath + ".md";
  const escapedPath = notePath.replace(/'/g, "\\'");

  // JavaScript to run inside Obsidian:
  // 1. Get the file by path
  // 2. Open it in a leaf (doesn't require focus)
  // 3. Run the entity linker command
  const code = `
    (async () => {
      const file = app.vault.getAbstractFileByPath('${escapedPath}');
      if (!file) return 'File not found: ${escapedPath}';
      await app.workspace.getLeaf(true).openFile(file);
      const result = await app.commands.executeCommandById('entity-linker:link-entities');
      return result ? 'linked' : 'no-matches';
    })()
  `.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

  try {
    const result = runCli(`eval code="${code.replace(/"/g, '\\"')}"`, {
      timeout: 120000, // Entity linking uses LLM, may take a while
    });
    return result;
  } catch (err) {
    return err.message;
  }
}

// Get recently modified notes
function getRecentNotes(days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const notes = [];

  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden files/folders and .obsidian
        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > cutoff) {
            const relativePath = path.relative(VAULT, fullPath);
            notes.push({
              path: relativePath,
              modified: stat.mtimeMs,
            });
          }
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  scanDir(VAULT);

  // Sort by most recently modified first
  notes.sort((a, b) => b.modified - a.modified);
  return notes;
}

// Search for notes matching a query
function searchNotes(query) {
  const result = runCli(
    `search:context query="${query.replace(/"/g, '\\"')}" format=json limit=10`,
    { timeout: 60000 }
  );

  if (!result || result === "[]") {
    return [];
  }

  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Wait for LLM processing to complete (with timeout)
async function waitForProcessing(ms = 5000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Link entities in a specific note
async function linkEntitiesInNote({ notePath, noteQuery }) {
  if (!notePath && !noteQuery) {
    throw new Error("Either notePath or noteQuery is required");
  }

  let targetPath = notePath;

  // If query provided, search for the note
  if (noteQuery && !notePath) {
    const results = searchNotes(noteQuery);
    if (results.length === 0) {
      return `No notes found matching: "${noteQuery}"`;
    }
    // Use the first match
    targetPath = results[0].file || results[0].path;
    if (!targetPath) {
      return `Could not determine path for: "${noteQuery}"`;
    }
  }

  try {
    const result = runEntityLinkerOnNote(targetPath);

    // Wait for LLM to process
    await waitForProcessing(8000);

    if (result.includes("not found")) {
      return result;
    }
    return `Linked entities in: ${targetPath}`;
  } catch (err) {
    return `Error linking entities in ${targetPath}: ${err.message}`;
  }
}

// Link entities in all recent notes
async function linkEntitiesInRecentNotes({ days = 7, limit = 20 }) {
  const recentNotes = getRecentNotes(days);

  if (recentNotes.length === 0) {
    return `No notes modified in the last ${days} days`;
  }

  // Limit the number of notes to process
  const notesToProcess = recentNotes.slice(0, limit);
  const results = [];

  for (let i = 0; i < notesToProcess.length; i++) {
    const note = notesToProcess[i];
    console.log(`[entity-linker] Processing ${i + 1}/${notesToProcess.length}: ${note.path}`);

    try {
      const result = runEntityLinkerOnNote(note.path);

      // Wait for LLM processing
      await waitForProcessing(8000);

      results.push({ path: note.path, status: "processed", result });
    } catch (err) {
      results.push({ path: note.path, status: "error", error: err.message });
    }
  }

  const processed = results.filter((r) => r.status === "processed").length;
  const errors = results.filter((r) => r.status === "error").length;

  let summary = `Processed ${processed} of ${notesToProcess.length} recent notes`;
  if (errors > 0) {
    summary += ` (${errors} errors)`;
  }
  if (recentNotes.length > limit) {
    summary += `. Note: Limited to ${limit} notes, ${recentNotes.length - limit} more available.`;
  }

  return summary;
}

// Tool definitions
const ENTITY_LINKER_TOOLS = [
  {
    type: "function",
    function: {
      name: "link_entities_in_note",
      description:
        "Run the Entity Linker plugin on a specific note to automatically add wiki-links for people, companies, and tags. " +
        "Provide either a notePath (relative path like 'Projects/Slack.md') or a noteQuery (search term like 'Slack').",
      parameters: {
        type: "object",
        properties: {
          notePath: {
            type: "string",
            description: "Relative path to the note (e.g., 'Projects/Slack.md')",
          },
          noteQuery: {
            type: "string",
            description: "Search query to find the note (e.g., 'Slack' or 'meeting notes')",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_entities_in_recent_notes",
      description:
        "Run the Entity Linker plugin on all recently modified notes. " +
        "This will scan notes modified in the last N days and automatically add wiki-links for people, companies, and tags. " +
        "This operation can take several minutes depending on the number of notes.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of days to look back for modified notes (default: 7)",
          },
          limit: {
            type: "number",
            description: "Maximum number of notes to process (default: 20)",
          },
        },
        required: [],
      },
    },
  },
];

async function executeEntityLinkerTool(name, args) {
  switch (name) {
    case "link_entities_in_note":
      return await linkEntitiesInNote(args);
    case "link_entities_in_recent_notes":
      return await linkEntitiesInRecentNotes(args);
    default:
      throw new Error(`Unknown entity linker tool: ${name}`);
  }
}

module.exports = { ENTITY_LINKER_TOOLS, executeEntityLinkerTool };
