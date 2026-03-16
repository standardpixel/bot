const { executeAOLShortcutTool } = require("./aol-shortcut");
const { executeStableDiffusionTool } = require("./stable-diffusion");
const { executeAOL1995Tool } = require("./aol1995");

const AOL_ALL_TOOLS = [
  {
    type: "function",
    function: {
      name: "start_all_aol_services",
      description: "Start all AOL-related services: AOL Shortcut, Stable Diffusion WebUI, and AOL 1995 server. This is a convenience tool that launches everything at once.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function startAllAOLServices() {
  const results = {
    success: true,
    services: {},
    message: "Started all AOL services",
  };

  // Start AOL Shortcut
  try {
    results.services.aol_shortcut = executeAOLShortcutTool("start_aol_shortcut");
  } catch (error) {
    results.services.aol_shortcut = {
      success: false,
      error: error.message,
    };
    results.success = false;
  }

  // Start Stable Diffusion
  try {
    results.services.stable_diffusion = executeStableDiffusionTool("start_stable_diffusion");
  } catch (error) {
    results.services.stable_diffusion = {
      success: false,
      error: error.message,
    };
    results.success = false;
  }

  // Start AOL 1995 Server
  try {
    results.services.aol1995_server = executeAOL1995Tool("start_aol1995_server");
  } catch (error) {
    results.services.aol1995_server = {
      success: false,
      error: error.message,
    };
    results.success = false;
  }

  if (!results.success) {
    results.message = "Some AOL services failed to start (see details above)";
  }

  return results;
}

function executeAOLAllTool(name, args = {}) {
  switch (name) {
    case "start_all_aol_services":
      return startAllAOLServices();
    default:
      throw new Error(`Unknown AOL All tool: ${name}`);
  }
}

module.exports = { AOL_ALL_TOOLS, executeAOLAllTool };
