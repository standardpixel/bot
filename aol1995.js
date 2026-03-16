const { spawn } = require("child_process");

const AOL1995_TOOLS = [
  {
    type: "function",
    function: {
      name: "start_aol1995_server",
      description: "Start the AOL 1995 Next.js development server with HTTPS enabled on port 3010. This starts the web server in the background.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function startAOL1995Server() {
  const projectPath = "/Users/eric/src/aol1995";

  // Start the HTTPS server with port 3010
  // Uses npm run dev:https which runs tsx server.ts
  const child = spawn("npm", ["run", "dev:https"], {
    cwd: projectPath,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HTTPS_PORT: "3010",
    },
  });

  // Detach the child process so it continues running
  child.unref();

  return {
    success: true,
    message: "AOL 1995 server started with HTTPS on port 3010",
    url: "https://localhost:3010",
    pid: child.pid,
  };
}

function executeAOL1995Tool(name, args = {}) {
  switch (name) {
    case "start_aol1995_server":
      return startAOL1995Server();
    default:
      throw new Error(`Unknown AOL 1995 tool: ${name}`);
  }
}

module.exports = { AOL1995_TOOLS, executeAOL1995Tool };
