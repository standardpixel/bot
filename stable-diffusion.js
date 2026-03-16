const { spawn } = require("child_process");
const path = require("path");

const STABLE_DIFFUSION_TOOLS = [
  {
    type: "function",
    function: {
      name: "start_stable_diffusion",
      description: "Start the Stable Diffusion WebUI with API enabled. This starts the web server in the background.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function startStableDiffusion() {
  const webUIPath = "/Users/eric/stable-diffusion-webui/webui.sh";

  // Start the process in detached mode so it runs in the background
  const child = spawn(webUIPath, ["--api"], {
    cwd: path.dirname(webUIPath),
    detached: true,
    stdio: "ignore", // Don't pipe stdio, let it run independently
  });

  // Detach the child process so it continues running after this function returns
  child.unref();

  return {
    success: true,
    message: "Stable Diffusion WebUI started with API enabled",
    pid: child.pid,
  };
}

function executeStableDiffusionTool(name, args = {}) {
  switch (name) {
    case "start_stable_diffusion":
      return startStableDiffusion();
    default:
      throw new Error(`Unknown Stable Diffusion tool: ${name}`);
  }
}

module.exports = { STABLE_DIFFUSION_TOOLS, executeStableDiffusionTool };
