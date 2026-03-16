const fs = require("fs");
const path = require("path");
const os = require("os");

// Strip shell escape characters (e.g. "\ " → " ", "\~" → "~") and expand ~
const rawVault = (process.env.OBSIDIAN_VAULT_PATH || "").replace(/\\(.)/g, "$1");
const VAULT = rawVault.startsWith("~")
  ? path.join(os.homedir(), rawVault.slice(1))
  : rawVault;
const MAX_SEARCH_RESULTS = 20;
const SEARCH_SNIPPET_CHARS = 200;

function requireVault() {
  if (!VAULT) throw new Error("OBSIDIAN_VAULT_PATH is not set in .env");
  if (!fs.existsSync(VAULT)) {
    throw new Error(`Vault path does not exist: ${VAULT}. This may be an iCloud sync issue. Make sure the vault is fully downloaded.`);
  }
}

// Prevent path traversal attacks
function safePath(relativePath) {
  const resolved = path.resolve(VAULT, relativePath);
  if (!resolved.startsWith(path.resolve(VAULT) + path.sep) && resolved !== path.resolve(VAULT)) {
    throw new Error("Invalid path: must be inside the vault");
  }
  if (!resolved.endsWith(".md") && !fs.statSync(resolved).isDirectory()) {
    throw new Error("Only .md files are permitted");
  }
  return resolved;
}

// Walk vault recursively, yielding .md file paths
function* walkVault(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) yield* walkVault(full);
        else if (entry.name.endsWith(".md")) yield full;
      } catch (err) {
        // Skip files that can't be accessed (e.g., iCloud placeholders)
        console.warn(`[walkVault] Skipping ${full}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[walkVault] Cannot read directory ${dir}: ${err.message}`);
  }
}

// --- Tool implementations ---

function searchNotes({ query }) {
  requireVault();
  const lower = query.toLowerCase();
  const results = [];
  let skippedFiles = 0;
  for (const full of walkVault(VAULT)) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const rel = path.relative(VAULT, full);
    try {
      const content = fs.readFileSync(full, "utf-8");
      const idx = content.toLowerCase().indexOf(lower);
      const titleMatch = rel.toLowerCase().includes(lower);
      if (idx >= 0 || titleMatch) {
        const start = Math.max(0, idx - 80);
        const snippet = idx >= 0
          ? "..." + content.slice(start, start + SEARCH_SNIPPET_CHARS).trim() + "..."
          : "";
        results.push({ path: rel, snippet });
      }
    } catch (err) {
      // Skip files that can't be read (e.g., iCloud placeholders not yet downloaded)
      console.warn(`[searchNotes] Skipping ${rel}: ${err.message}`);
      skippedFiles++;
    }
  }

  if (results.length === 0 && skippedFiles > 0) {
    return `No notes found matching: "${query}". (Note: ${skippedFiles} files were skipped, possibly due to iCloud sync. Try again in a moment.)`;
  }

  return results.length > 0
    ? results
    : `No notes found matching: "${query}"`;
}

function readNote({ path: relativePath }) {
  requireVault();
  const full = safePath(relativePath);
  if (!fs.existsSync(full)) throw new Error(`Note not found: ${relativePath}`);
  return fs.readFileSync(full, "utf-8");
}

function listVault({ folder = "" }) {
  requireVault();
  const dir = folder ? path.resolve(VAULT, folder) : VAULT;
  if (!dir.startsWith(path.resolve(VAULT))) throw new Error("Invalid folder path");
  if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${folder}`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "folder" : "file",
      path: path.relative(VAULT, path.join(dir, e.name)),
    }));
}

function createNote({ path: relativePath, content }) {
  requireVault();
  if (!relativePath.endsWith(".md")) relativePath += ".md";
  const full = path.resolve(VAULT, relativePath);
  if (!full.startsWith(path.resolve(VAULT))) throw new Error("Invalid path");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return `Created: ${relativePath}`;
}

function appendToNote({ path: relativePath, content }) {
  requireVault();
  const full = safePath(relativePath);
  if (!fs.existsSync(full)) throw new Error(`Note not found: ${relativePath}`);
  fs.appendFileSync(full, "\n" + content, "utf-8");
  return `Appended to: ${relativePath}`;
}

function writeDailyNote({ content, date }) {
  requireVault();
  const dateStr = date || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const filename = `${dateStr}.md`;
  const full = path.resolve(VAULT, filename);
  if (!full.startsWith(path.resolve(VAULT))) throw new Error("Invalid path");
  if (fs.existsSync(full)) {
    fs.appendFileSync(full, "\n" + content, "utf-8");
    return `Appended to daily note: ${filename}`;
  } else {
    fs.writeFileSync(full, content, "utf-8");
    return `Created daily note: ${filename}`;
  }
}

// --- OpenAI tool definitions ---

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Search for notes in the Obsidian vault by keyword or phrase. Returns matching file paths and snippets.",
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
          path: { type: "string", description: "Relative path to the note from the vault root, e.g. 'Projects/idea.md'" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_vault",
      description: "List files and folders inside the vault or a subfolder.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Relative path to a subfolder, or empty string for the vault root" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note (or overwrite an existing one) with the given markdown content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path for the note, e.g. 'Daily/2025-02-17.md'" },
          content: { type: "string", description: "Full markdown content of the note" },
        },
        required: ["path", "content"],
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
        "Write content to today's daily note (YYYY-MM-DD.md in the vault root). " +
        "If the file already exists the content is appended; otherwise the file is created. " +
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
    case "read_note":      return readNote(args);
    case "list_vault":     return listVault(args);
    case "create_note":    return createNote(args);
    case "append_to_note":  return appendToNote(args);
    case "write_daily_note": return writeDailyNote(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, executeTool };
