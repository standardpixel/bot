const { execSync } = require("child_process");

const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/obsidian";

// Run an Obsidian CLI command and return the result
function runCli(command, options = {}) {
  const timeout = options.timeout || 30000;

  try {
    const result = execSync(`"${OBSIDIAN_BIN}" ${command} 2>/dev/null`, {
      encoding: "utf8",
      timeout,
      shell: "/bin/bash",
      maxBuffer: 10 * 1024 * 1024, // 10MB for large search results
    }).trim();
    return result;
  } catch (err) {
    if (err.killed) {
      throw new Error(`CLI command timed out after ${timeout}ms`);
    }
    // Check if it's a "not enabled" error
    if (err.message && err.message.includes("CLI is not enabled")) {
      throw new Error(
        "Obsidian CLI is not enabled. Enable it in Obsidian Settings → General → Command line interface"
      );
    }
    throw new Error(`CLI error: ${err.message}`);
  }
}

// --- Tool implementations ---

function searchNotes({ query }) {
  if (!query) throw new Error("Query is required");

  // Use Obsidian's search:context command for snippets
  const result = runCli(
    `search:context query="${query.replace(/"/g, '\\"')}" format=json limit=20`,
    { timeout: 60000 }
  );

  if (!result || result === "[]") {
    return `No notes found matching: "${query}"`;
  }

  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed) && parsed.length === 0) {
      return `No notes found matching: "${query}"`;
    }
    return parsed;
  } catch {
    // If not JSON, return as-is (might be formatted text)
    return result || `No notes found matching: "${query}"`;
  }
}

function readNote({ path: relativePath }) {
  if (!relativePath) throw new Error("Path is required");

  // Use path= for exact path matching
  const result = runCli(`read path="${relativePath.replace(/"/g, '\\"')}"`);
  return result;
}

function listVault({ folder = "" }) {
  // Use files and folders commands
  const folderArg = folder ? `folder="${folder.replace(/"/g, '\\"')}"` : "";

  const filesResult = runCli(`files ${folderArg}`.trim());
  const foldersResult = runCli(`folders ${folderArg}`.trim());

  // Parse results (one item per line)
  const files = filesResult
    ? filesResult.split("\n").filter(Boolean).map((f) => ({ name: f.split("/").pop(), type: "file", path: f }))
    : [];
  const folders = foldersResult
    ? foldersResult.split("\n").filter(Boolean).map((f) => ({ name: f.split("/").pop(), type: "folder", path: f }))
    : [];

  return [...folders, ...files];
}

function createNote({ path: relativePath, content, template }) {
  if (!relativePath) throw new Error("Path is required");

  // Ensure .md extension
  const notePath = relativePath.endsWith(".md") ? relativePath : relativePath + ".md";

  // Build command with path= for exact location
  let cmd = `create path="${notePath.replace(/"/g, '\\"')}"`;

  if (template) {
    cmd += ` template="${template.replace(/"/g, '\\"')}"`;
  }

  if (content) {
    cmd += ` content="${content.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }

  runCli(cmd);
  return `Created: ${notePath}`;
}

function appendToNote({ path: relativePath, content }) {
  if (!relativePath) throw new Error("Path is required");
  if (!content) throw new Error("Content is required");

  const cmd = `append path="${relativePath.replace(/"/g, '\\"')}" content="${content.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

  runCli(cmd);
  return `Appended to: ${relativePath}`;
}

function writeDailyNote({ content, date }) {
  if (!content) throw new Error("Content is required");

  const escapedContent = content.replace(/"/g, '\\"').replace(/\n/g, "\\n");

  if (date) {
    // For specific dates, use append with the daily note path
    // Assumes YYYY-MM-DD.md format in vault root (standard Obsidian daily notes)
    const dailyPath = `${date}.md`;
    runCli(`append path="${dailyPath}" content="${escapedContent}"`);
    return `Written to daily note: ${dailyPath}`;
  }

  // For today, use daily:append which handles creation and respects daily notes settings
  runCli(`daily:append content="${escapedContent}"`);

  const todayStr = new Date().toISOString().split("T")[0];
  return `Written to daily note: ${todayStr}.md`;
}

// --- OpenAI tool definitions ---

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Search for notes in the Obsidian vault by keyword or phrase. Returns matching file paths and snippets. The vault is organized using PARA: Projects/, Areas/, Resources/, Archives/. People are in Resources/People/, companies in Resources/Companies/.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword or phrase to search for in note titles and content" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full markdown content of a specific note.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the note from the vault root, e.g. 'Projects/MyProject.md' or 'Resources/People/John.md'" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_vault",
      description: "List files and folders inside the vault or a subfolder. The vault uses PARA organization: Projects/, Areas/, Resources/, Archives/.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Relative path to a subfolder (e.g. 'Projects', 'Resources/People'), or empty for vault root" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note with the given markdown content. Can optionally use an Obsidian template. Place notes in appropriate PARA folders: Projects/ for active projects, Areas/ for ongoing responsibilities, Resources/ for reference material, Archives/ for completed items.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path for the note using PARA structure, e.g. 'Projects/NewProject.md' or 'Resources/People/Jane.md'" },
          content: { type: "string", description: "Markdown content of the note (optional if using template)" },
          template: { type: "string", description: "Name of an Obsidian template to use (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_to_note",
      description: "Append text to the end of an existing note.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the note" },
          content: { type: "string", description: "Markdown content to append" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_daily_note",
      description:
        "Write content to today's daily note (or a specific date). " +
        "Content is appended if the daily note already exists. " +
        "Use this — never create_note — when the user asks to add something to their daily note.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Markdown content to write" },
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD format. Defaults to today if omitted.",
          },
        },
        required: ["content"],
      },
    },
  },
];

function executeTool(name, args) {
  switch (name) {
    case "search_notes":    return searchNotes(args);
    case "read_note":       return readNote(args);
    case "list_vault":      return listVault(args);
    case "create_note":     return createNote(args);
    case "append_to_note":  return appendToNote(args);
    case "write_daily_note": return writeDailyNote(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, executeTool };
