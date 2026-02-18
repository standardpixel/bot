const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SITE_DIR = path.join(os.homedir(), "src", "standardpixel.com");
const ARTICLES_FILE = path.join(SITE_DIR, "_data", "articles.yml");

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addArticle({ title, url, note, date }) {
  const dateStr = date || todayStr();

  // Build YAML entry using JSON.stringify for safe double-quoted strings
  let entry = `\n- title: ${JSON.stringify(title)}\n  url: ${JSON.stringify(url)}\n  date: ${dateStr}`;
  if (note) entry += `\n  note: ${JSON.stringify(note)}`;
  entry += "\n";

  fs.appendFileSync(ARTICLES_FILE, entry, "utf-8");

  execFileSync("git", ["-C", SITE_DIR, "add", "_data/articles.yml"]);
  execFileSync("git", ["-C", SITE_DIR, "commit", "-m", `Add article: ${title}`]);
  execFileSync("git", ["-C", SITE_DIR, "push", "origin", "master"], { timeout: 30000 });

  return `Added and deployed: "${title}" — changes will be live on standardpixel.com/articles.html shortly.`;
}

const LINKS_TOOLS = [
  {
    type: "function",
    function: {
      name: "add_article",
      description:
        "Add a link/article to the standardpixel.com links page and deploy it. " +
        "Appends the entry to _data/articles.yml, commits, and pushes to GitHub Pages. " +
        "Use this whenever the user asks to add a link or article to their site.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the article or link" },
          url:   { type: "string", description: "Full URL of the article" },
          note:  { type: "string", description: "Optional short note or comment about the article" },
          date:  { type: "string", description: "Date in YYYY-MM-DD format. Defaults to today if omitted." },
        },
        required: ["title", "url"],
      },
    },
  },
];

function executeLinksTool(name, args) {
  switch (name) {
    case "add_article": return addArticle(args);
    default: throw new Error(`Unknown links tool: ${name}`);
  }
}

module.exports = { LINKS_TOOLS, executeLinksTool };
