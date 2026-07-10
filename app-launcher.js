const { execSync } = require("child_process");
const os = require("os");

const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/obsidian";

// Get the vault path from environment
function getVaultPath() {
  let vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    throw new Error("OBSIDIAN_VAULT_PATH environment variable not set");
  }

  // Expand ~ to home directory
  if (vaultPath.startsWith('~')) {
    vaultPath = vaultPath.replace(/^~/, os.homedir());
  }

  // Remove escaped backslashes (shell escaping not needed in Node)
  vaultPath = vaultPath.replace(/\\/g, '');

  return vaultPath;
}

// Check if an application is running on macOS
function isAppRunning(appName) {
  try {
    const script = `osascript -e 'tell application "System Events" to (name of processes) contains "${appName}"'`;
    const result = execSync(script, { encoding: "utf8" }).trim();
    return result === "true";
  } catch (err) {
    console.error(`[app-launcher] Error checking if ${appName} is running:`, err.message);
    return false;
  }
}

// Check if Obsidian CLI is responsive
function isObsidianCliReady() {
  try {
    // Try a simple CLI command to verify Obsidian is ready
    execSync(`"${OBSIDIAN_BIN}" vault 2>/dev/null`, {
      encoding: "utf8",
      timeout: 3000,
      shell: "/bin/bash",
    });
    return true;
  } catch (err) {
    return false;
  }
}

// Check if the correct vault is open in Obsidian
function isCorrectVaultOpen() {
  try {
    const vaultPath = getVaultPath();

    // Try to run a simple search command instead of vault command
    // If this succeeds, the vault is open and responding
    const result = execSync(`"${OBSIDIAN_BIN}" search query="test" limit=1 2>&1`, {
      encoding: "utf8",
      timeout: 3000,
      shell: "/bin/bash",
    }).trim();

    console.log(`[app-launcher] Vault CLI test result: ${result.substring(0, 100)}`);

    // If we get here without an error, the vault is responding
    // Check if we got an error message about vault not being open
    if (result.includes("No vault") || result.includes("not found") || result.includes("not open")) {
      console.log(`[app-launcher] Vault is not open or not found`);
      return false;
    }

    console.log(`[app-launcher] Vault appears to be open and responding`);
    return true;
  } catch (err) {
    console.error(`[app-launcher] Error checking vault:`, err.message);
    console.error(`[app-launcher] Error stderr:`, err.stderr?.toString() || 'N/A');
    console.error(`[app-launcher] Error stdout:`, err.stdout?.toString() || 'N/A');
    return false;
  }
}

// Open a specific vault in Obsidian
function openVault() {
  try {
    const vaultPath = getVaultPath();
    console.log(`[app-launcher] Opening vault: ${vaultPath}`);

    // Use macOS 'open' command to open the vault folder with Obsidian
    // This is more reliable than trying to use Obsidian's CLI to switch vaults
    execSync(`open -a Obsidian "${vaultPath.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      timeout: 5000,
      shell: "/bin/bash",
    });

    console.log(`[app-launcher] Waiting for vault to be ready...`);

    // Wait for vault to be open
    const startTime = Date.now();
    const maxTimeout = 15000; // 15 seconds max
    const checkInterval = 1000; // Check every second
    let lastCheckTime = startTime;

    while (Date.now() - startTime < maxTimeout) {
      if (Date.now() - lastCheckTime >= checkInterval) {
        if (isCorrectVaultOpen()) {
          console.log(`[app-launcher] Vault is now open and responding`);
          return true;
        }
        lastCheckTime = Date.now();
      }
      // Small sleep to prevent tight loop
      execSync("sleep 0.1");
    }

    // If we get here, we timed out, but let's try one more time
    console.log(`[app-launcher] Timeout reached, doing final check...`);
    if (isCorrectVaultOpen()) {
      console.log(`[app-launcher] Vault is open (final check succeeded)`);
      return true;
    }

    // Give up but log a warning instead of throwing
    console.warn(`[app-launcher] Could not verify vault is open after ${maxTimeout}ms, proceeding anyway...`);
    // Wait a bit more for good measure
    execSync("sleep 3");
    return true; // Optimistically assume it worked
  } catch (err) {
    console.error(`[app-launcher] Error opening vault:`, err.message);
    throw new Error(`Failed to open vault: ${err.message}`);
  }
}

// Launch and activate an application on macOS
function launchApp(appName) {
  try {
    console.log(`[app-launcher] Launching and activating ${appName}...`);

    // Use a more robust activation script that brings the app to the foreground
    const script = `osascript -e 'tell application "${appName}"
      activate
      delay 0.5
    end tell'`;
    execSync(script, { encoding: "utf8" });

    // Wait for the app to be running
    const startTime = Date.now();
    const timeout = 15000; // 15 seconds timeout

    while (!isAppRunning(appName)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Timeout waiting for ${appName} to start`);
      }
      // Sleep for 500ms
      execSync("sleep 0.5");
    }

    console.log(`[app-launcher] ${appName} is now running`);

    // For Obsidian, verify CLI is responsive and open the correct vault
    if (appName === "Obsidian") {
      console.log(`[app-launcher] Waiting for Obsidian CLI to be ready...`);
      const cliStartTime = Date.now();
      const cliTimeout = 10000; // 10 seconds for CLI to be ready

      while (!isObsidianCliReady()) {
        if (Date.now() - cliStartTime > cliTimeout) {
          throw new Error("Obsidian is running but CLI is not responding. Make sure CLI is enabled in Obsidian Settings → General → Command line interface");
        }
        // Sleep for 1 second between checks
        execSync("sleep 1");
      }
      console.log(`[app-launcher] Obsidian CLI is ready`);

      // Now ensure the correct vault is open
      if (!isCorrectVaultOpen()) {
        console.log(`[app-launcher] Correct vault is not open, opening it now...`);
        openVault();
      } else {
        console.log(`[app-launcher] Correct vault is already open`);
      }
    }

    return true;
  } catch (err) {
    console.error(`[app-launcher] Error launching ${appName}:`, err.message);
    throw new Error(`Failed to launch ${appName}: ${err.message}`);
  }
}

// Ensure both Obsidian and LM Studio are running and ready
async function ensureAppsRunning() {
  const obsidianAppName = "Obsidian";
  const lmStudioAppName = "LM Studio";

  const appsToLaunch = [];

  // Check Obsidian - needs to be running AND have the correct vault open
  if (!isAppRunning(obsidianAppName)) {
    console.log(`[app-launcher] ${obsidianAppName} is not running`);
    appsToLaunch.push(obsidianAppName);
  } else if (!isObsidianCliReady()) {
    // Obsidian is running but CLI is not ready - need to activate it
    console.log(`[app-launcher] ${obsidianAppName} is running but CLI is not ready - activating`);
    appsToLaunch.push(obsidianAppName);
  } else {
    // Check if vault is open, but don't fail if we can't verify
    console.log(`[app-launcher] ${obsidianAppName} is running, checking vault...`);
    const vaultOpen = isCorrectVaultOpen();
    if (!vaultOpen) {
      // Try to open vault but don't fail hard
      console.log(`[app-launcher] Vault may not be open, attempting to open it...`);
      try {
        openVault();
      } catch (err) {
        console.warn(`[app-launcher] Could not verify vault opening: ${err.message}`);
        console.warn(`[app-launcher] Proceeding anyway - vault commands may fail if vault is not actually open`);
      }
    } else {
      console.log(`[app-launcher] ${obsidianAppName} vault is open and ready`);
    }
  }

  if (!isAppRunning(lmStudioAppName)) {
    console.log(`[app-launcher] ${lmStudioAppName} is not running`);
    appsToLaunch.push(lmStudioAppName);
  } else {
    console.log(`[app-launcher] ${lmStudioAppName} is already running`);
  }

  // Launch/activate apps that aren't ready
  for (const appName of appsToLaunch) {
    launchApp(appName);
  }

  return appsToLaunch;
}

module.exports = {
  isAppRunning,
  launchApp,
  ensureAppsRunning,
};
