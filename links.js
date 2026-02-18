const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SITE_DIR = path.join(os.homedir(), "src", "standardpixel.com");
const SYNC_SCRIPT = path.join(SITE_DIR, "sync-articles.rb");

const rawVault = (process.env.OBSIDIAN_VAULT_PATH || "").replace(/\\(.)/g, "$1");
const VAULT = rawVault.startsWith("~") ? path.join(os.homedir(), rawVault.slice(1)) : rawVault;
const LINKS_MD = path.join(VAULT, "Links.md");

// Run the sync script, then commit with --no-verify (hook would re-run the
// same sync redundantly) and push to GitHub Pages.
function syncAndDeploy() {
  execFileSync("ruby", [SYNC_SCRIPT], { cwd: SITE_DIR, timeout: 120000 });

  const diff = execFileSync("git", ["-C", SITE_DIR, "diff", "--name-only", "_data/articles.yml"])
    .toString()
    .trim();

  if (!diff) {
    return "No new articles found — links page is already up to date.";
  }

  execFileSync("git", ["-C", SITE_DIR, "add", "_data/articles.yml"]);
  execFileSync("git", ["-C", SITE_DIR, "commit", "--no-verify", "-m", "Update articles from Obsidian"]);
  execFileSync("git", ["-C", SITE_DIR, "push", "origin", "master"], { timeout: 30000 });

  // GitHub Pages serves from gh-pages — keep it in sync with master
  execFileSync("git", ["-C", SITE_DIR, "checkout", "gh-pages"]);
  execFileSync("git", ["-C", SITE_DIR, "merge", "master", "--no-edit"]);
  execFileSync("git", ["-C", SITE_DIR, "push", "origin", "gh-pages"], { timeout: 30000 });
  execFileSync("git", ["-C", SITE_DIR, "checkout", "master"]);

  return "Links page synced and deployed — changes will be live on standardpixel.com/articles.html shortly.";
}

// Append a URL to Obsidian's Links.md, then sync and deploy.
function addArticle({ url, note }) {
  if (!VAULT) throw new Error("OBSIDIAN_VAULT_PATH is not set in .env");
  if (!fs.existsSync(LINKS_MD)) throw new Error(`Links.md not found at ${LINKS_MD}`);

  let entry = `\n- ${url}`;
  if (note) entry += ` - ${note}`;
  fs.appendFileSync(LINKS_MD, entry, "utf-8");

  return syncAndDeploy();
}

const LINKS_TOOLS = [
  {
    type: "function",
    function: {
      name: "add_article",
      description:
        "Add a URL to the standardpixel.com links page and deploy it. " +
        "Appends the URL to Obsidian's Links.md (the source of truth), runs the sync " +
        "script to fetch the title and regenerate articles.yml, then pushes to GitHub Pages. " +
        "Use this when the user asks to add a link or article to their site.",
      parameters: {
        type: "object",
        properties: {
          url:  { type: "string", description: "Full URL of the article" },
          note: { type: "string", description: "Optional short note or comment about the article" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deploy_links",
      description:
        "Sync and deploy the standardpixel.com links page from Obsidian's Links.md. " +
        "Use this when the user has already added links to Links.md and wants to publish them, " +
        "or just wants to deploy any pending link changes.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function executeLinksTool(name, args) {
  switch (name) {
    case "add_article":  return addArticle(args);
    case "deploy_links": return syncAndDeploy();
    default: throw new Error(`Unknown links tool: ${name}`);
  }
}

module.exports = { LINKS_TOOLS, executeLinksTool };
