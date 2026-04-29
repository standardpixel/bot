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

function archiveNote({ path: relativePath }) {
  if (!relativePath) throw new Error("Path is required");

  // Ensure .md extension for consistency
  const notePath = relativePath.endsWith(".md") ? relativePath : relativePath + ".md";
  const fileName = notePath.split("/").pop();

  // Determine destination path in Archive folder
  // If already in a subfolder structure, preserve it under Archive
  const pathParts = notePath.split("/");
  let destPath;
  if (pathParts.length > 1 && pathParts[0] !== "Archive") {
    // e.g., Projects/MyProject.md -> Archive/Projects/MyProject.md
    destPath = `Archive/${notePath}`;
  } else if (pathParts[0] === "Archive") {
    throw new Error("Note is already in Archive");
  } else {
    // Root level file -> Archive/filename.md
    destPath = `Archive/${fileName}`;
  }

  // First verify the source file exists
  try {
    runCli(`file path="${notePath.replace(/"/g, '\\"')}"`);
  } catch (err) {
    throw new Error(`Source file not found: ${notePath}`);
  }

  // Move the file
  runCli(`move path="${notePath.replace(/"/g, '\\"')}" to="${destPath.replace(/"/g, '\\"')}"`);

  // Verify the move succeeded by checking the file exists at destination
  try {
    runCli(`file path="${destPath.replace(/"/g, '\\"')}"`);
  } catch (err) {
    throw new Error(`Move failed: file not found at destination ${destPath}`);
  }

  return `Archived: ${notePath} → ${destPath}`;
}

function commitVault({ message } = {}) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    throw new Error("OBSIDIAN_VAULT_PATH environment variable not set");
  }

  try {
    // Check if vault is a git repository
    try {
      execSync("git rev-parse --git-dir", { cwd: vaultPath, stdio: "ignore" });
    } catch (err) {
      throw new Error("Vault is not a git repository. Initialize git first.");
    }

    // Check if there are any changes to commit
    const status = execSync("git status --porcelain", {
      cwd: vaultPath,
      encoding: "utf8"
    }).trim();

    if (!status) {
      return "No changes to commit in vault.";
    }

    // Generate smart commit message if none provided
    let commitMessage = message;
    if (!commitMessage) {
      // Parse the status to categorize changes
      const lines = status.split("\n");
      const stats = {
        added: [],
        modified: [],
        deleted: [],
        renamed: []
      };

      lines.forEach(line => {
        const statusCode = line.substring(0, 2);
        const filePath = line.substring(3);

        if (statusCode.includes('A')) stats.added.push(filePath);
        else if (statusCode.includes('M')) stats.modified.push(filePath);
        else if (statusCode.includes('D')) stats.deleted.push(filePath);
        else if (statusCode.includes('R')) stats.renamed.push(filePath);
        else if (statusCode === '??') stats.added.push(filePath);
      });

      // Build a descriptive message
      const parts = [];
      if (stats.added.length > 0) {
        const noteNames = stats.added.slice(0, 3).map(f => f.replace(/\.md$/, ''));
        if (stats.added.length === 1) {
          parts.push(`Add ${noteNames[0]}`);
        } else if (stats.added.length <= 3) {
          parts.push(`Add ${noteNames.join(', ')}`);
        } else {
          parts.push(`Add ${stats.added.length} notes`);
        }
      }
      if (stats.modified.length > 0) {
        const noteNames = stats.modified.slice(0, 3).map(f => f.replace(/\.md$/, ''));
        if (stats.modified.length === 1) {
          parts.push(`Update ${noteNames[0]}`);
        } else if (stats.modified.length <= 3) {
          parts.push(`Update ${noteNames.join(', ')}`);
        } else {
          parts.push(`Update ${stats.modified.length} notes`);
        }
      }
      if (stats.deleted.length > 0) {
        if (stats.deleted.length === 1) {
          parts.push(`Delete ${stats.deleted[0].replace(/\.md$/, '')}`);
        } else {
          parts.push(`Delete ${stats.deleted.length} notes`);
        }
      }

      commitMessage = parts.length > 0
        ? parts.join('; ')
        : `Vault update - ${new Date().toLocaleDateString()}`;
    }

    // Add all changes
    execSync("git add -A", { cwd: vaultPath, stdio: "ignore" });

    // Create commit with message
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
      cwd: vaultPath,
      encoding: "utf8"
    });

    // Push to origin
    const pushOutput = execSync("git push origin HEAD", {
      cwd: vaultPath,
      encoding: "utf8",
      stdio: "pipe"
    });

    const changedFiles = status.split("\n").length;
    return `✅ Committed and pushed vault changes to origin.\n\nFiles changed: ${changedFiles}\nCommit message: "${commitMessage}"`;
  } catch (err) {
    // More detailed error messages
    if (err.message.includes("nothing to commit")) {
      return "No changes to commit in vault.";
    } else if (err.message.includes("not a git repository")) {
      throw new Error("Vault is not a git repository. Initialize git first.");
    } else if (err.message.includes("No configured push destination")) {
      throw new Error("No remote repository configured. Set up a remote with: git remote add origin <url>");
    } else {
      throw new Error(`Failed to commit vault: ${err.message}`);
    }
  }
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
  {
    type: "function",
    function: {
      name: "archive_note",
      description:
        "Move a note to the Archive folder. Use this when a project is completed or a note is no longer active. " +
        "The note will be moved to Archive/ preserving its folder structure (e.g., Projects/MyProject.md → Archive/Projects/MyProject.md). " +
        "This tool verifies the move succeeded before reporting success.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the note to archive, e.g. 'Projects/OldProject.md'",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_vault",
      description:
        "Commit all changes in the Obsidian vault and push to the remote repository. " +
        "Use this when the user asks to commit their vault, or before performing potentially destructive operations. " +
        "This creates a safety backup by committing and pushing all current changes. " +
        "If no commit message is provided, it automatically generates a descriptive message based on which notes were added, modified, or deleted.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Optional commit message. If omitted, an intelligent message will be auto-generated from the changes (e.g., 'Add Project X; Update 3 daily notes').",
          },
        },
        required: [],
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
    case "archive_note":    return archiveNote(args);
    case "commit_vault":    return commitVault(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, executeTool };
