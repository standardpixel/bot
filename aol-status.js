const { execSync } = require("child_process");

const AOL_STATUS_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_aol_services_status",
      description: "Check the running status of all AOL-related services: AOL 1995 server (port 3010) and Stable Diffusion WebUI (port 7860)",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function checkPortInUse(port) {
  try {
    const result = execSync(`lsof -i :${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (result) {
      // Parse the output to get process info
      const lines = result.split("\n");
      if (lines.length > 1) {
        const processLine = lines[1]; // First line is header, second is the process
        const parts = processLine.split(/\s+/);
        return {
          running: true,
          pid: parts[1],
          command: parts[0],
        };
      }
    }
    return { running: false };
  } catch (error) {
    // lsof returns non-zero exit code when no process is found
    return { running: false };
  }
}

function checkProcessRunning(processName) {
  try {
    const result = execSync(`pgrep -f "${processName}"`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (result) {
      const pids = result.split("\n").filter(pid => pid.length > 0);
      return {
        running: true,
        pids: pids,
        count: pids.length,
      };
    }
    return { running: false };
  } catch (error) {
    // pgrep returns non-zero exit code when no process is found
    return { running: false };
  }
}

function checkAOLServicesStatus() {
  const status = {
    aol1995_server: {
      name: "AOL 1995 Server",
      port: 3010,
      url: "https://localhost:3010",
      ...checkPortInUse(3010),
    },
    stable_diffusion: {
      name: "Stable Diffusion WebUI",
      port: 7860,
      url: "http://localhost:7860",
      ...checkPortInUse(7860),
    },
  };

  // Also check for the webui.sh process
  const webUIProcess = checkProcessRunning("webui.sh");
  if (webUIProcess.running) {
    status.stable_diffusion.process = webUIProcess;
  }

  // Check for node process running in aol1995 directory
  const aolProcess = checkProcessRunning("tsx server.ts");
  if (aolProcess.running) {
    status.aol1995_server.process = aolProcess;
  }

  // Summary
  const runningServices = [];
  const stoppedServices = [];

  if (status.aol1995_server.running) {
    runningServices.push("AOL 1995 Server");
  } else {
    stoppedServices.push("AOL 1995 Server");
  }

  if (status.stable_diffusion.running) {
    runningServices.push("Stable Diffusion WebUI");
  } else {
    stoppedServices.push("Stable Diffusion WebUI");
  }

  return {
    summary: {
      running: runningServices,
      stopped: stoppedServices,
      total_running: runningServices.length,
      total_stopped: stoppedServices.length,
    },
    services: status,
    note: "AOL Shortcut is a one-time action, not a persistent service",
  };
}

function executeAOLStatusTool(name, args = {}) {
  switch (name) {
    case "check_aol_services_status":
      return checkAOLServicesStatus();
    default:
      throw new Error(`Unknown AOL Status tool: ${name}`);
  }
}

module.exports = { AOL_STATUS_TOOLS, executeAOLStatusTool };
