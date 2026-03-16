const { execSync } = require("child_process");

const AOL_STOP_TOOLS = [
  {
    type: "function",
    function: {
      name: "stop_aol_services",
      description: "Stop all running AOL services: AOL 1995 server and Stable Diffusion WebUI. Note: AOL Shortcut is a one-time action and doesn't need to be stopped.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function stopProcessOnPort(port, serviceName) {
  try {
    // Find the process using the port
    const result = execSync(`lsof -ti :${port}`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (result) {
      const pids = result.split("\n").filter(pid => pid.length > 0);

      // Kill each process
      pids.forEach(pid => {
        try {
          execSync(`kill ${pid}`, { timeout: 5000 });
        } catch (err) {
          // Process might already be dead
        }
      });

      return {
        stopped: true,
        message: `Stopped ${serviceName} (PID: ${pids.join(", ")})`,
        pids: pids,
      };
    } else {
      return {
        stopped: false,
        message: `${serviceName} was not running`,
      };
    }
  } catch (error) {
    return {
      stopped: false,
      message: `${serviceName} was not running`,
    };
  }
}

function stopProcessByName(processPattern, serviceName) {
  try {
    const result = execSync(`pgrep -f "${processPattern}"`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (result) {
      const pids = result.split("\n").filter(pid => pid.length > 0);

      // Kill each process
      pids.forEach(pid => {
        try {
          execSync(`kill ${pid}`, { timeout: 5000 });
        } catch (err) {
          // Process might already be dead
        }
      });

      return {
        stopped: true,
        message: `Stopped ${serviceName} processes (PID: ${pids.join(", ")})`,
        pids: pids,
      };
    } else {
      return {
        stopped: false,
        message: `No ${serviceName} processes found`,
      };
    }
  } catch (error) {
    return {
      stopped: false,
      message: `No ${serviceName} processes found`,
    };
  }
}

function stopAOLServices() {
  const results = {
    services: {},
    summary: {
      stopped: [],
      already_stopped: [],
    },
  };

  // Stop AOL 1995 Server (port 3010)
  const aol1995Port = stopProcessOnPort(3010, "AOL 1995 Server");
  results.services.aol1995_server = aol1995Port;

  // Also try to kill tsx server.ts processes
  const aol1995Process = stopProcessByName("tsx server.ts", "AOL 1995");
  if (aol1995Process.stopped) {
    results.services.aol1995_server_process = aol1995Process;
  }

  if (aol1995Port.stopped || aol1995Process.stopped) {
    results.summary.stopped.push("AOL 1995 Server");
  } else {
    results.summary.already_stopped.push("AOL 1995 Server");
  }

  // Stop Stable Diffusion (port 7860)
  const stableDiffusionPort = stopProcessOnPort(7860, "Stable Diffusion WebUI");
  results.services.stable_diffusion = stableDiffusionPort;

  // Also try to kill webui.sh processes
  const webUIProcess = stopProcessByName("webui.sh", "Stable Diffusion");
  if (webUIProcess.stopped) {
    results.services.stable_diffusion_process = webUIProcess;
  }

  if (stableDiffusionPort.stopped || webUIProcess.stopped) {
    results.summary.stopped.push("Stable Diffusion WebUI");
  } else {
    results.summary.already_stopped.push("Stable Diffusion WebUI");
  }

  // Generate summary message
  let message = "";
  if (results.summary.stopped.length > 0) {
    message += `Stopped: ${results.summary.stopped.join(", ")}. `;
  }
  if (results.summary.already_stopped.length > 0) {
    message += `Already stopped: ${results.summary.already_stopped.join(", ")}.`;
  }

  results.message = message.trim();
  results.note = "AOL Shortcut is a one-time action and doesn't run as a persistent service";

  return results;
}

function executeAOLStopTool(name, args = {}) {
  switch (name) {
    case "stop_aol_services":
      return stopAOLServices();
    default:
      throw new Error(`Unknown AOL Stop tool: ${name}`);
  }
}

module.exports = { AOL_STOP_TOOLS, executeAOLStopTool };
