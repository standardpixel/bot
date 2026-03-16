const { spawn } = require("child_process");

const AOL_SHORTCUT_TOOLS = [
  {
    type: "function",
    function: {
      name: "start_aol_shortcut",
      description: "Run the 'AOL' macOS Shortcut",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function startAOLShortcut() {
  try {
    // Run the macOS Shortcut named "AOL" in the background
    const child = spawn("shortcuts", ["run", "AOL"], {
      detached: true,
      stdio: "ignore",
    });

    // Detach the child process so it continues running
    child.unref();

    return {
      success: true,
      message: "AOL shortcut started successfully",
      pid: child.pid,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to run AOL shortcut",
      error: error.message,
    };
  }
}

function executeAOLShortcutTool(name, args = {}) {
  switch (name) {
    case "start_aol_shortcut":
      return startAOLShortcut();
    default:
      throw new Error(`Unknown AOL Shortcut tool: ${name}`);
  }
}

module.exports = { AOL_SHORTCUT_TOOLS, executeAOLShortcutTool };
