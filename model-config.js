const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "model-config.json");

// Anthropic models available for selection
const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
];

/**
 * Load config from JSON file
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {
        defaultModel: { provider: "lmstudio", modelId: "default" },
        userModels: {},
      };
    }
    const data = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("[model-config] Error loading config:", err.message);
    return {
      defaultModel: { provider: "lmstudio", modelId: "default" },
      userModels: {},
    };
  }
}

/**
 * Save config to JSON file
 */
function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[model-config] Error saving config:", err.message);
  }
}

/**
 * Get model config for a specific user (falls back to default)
 */
function getUserModel(userId) {
  const config = loadConfig();
  if (config.userModels && config.userModels[userId]) {
    return config.userModels[userId];
  }
  return config.defaultModel;
}

/**
 * Set model config for a specific user
 */
function setUserModel(userId, provider, modelId) {
  const config = loadConfig();
  if (!config.userModels) {
    config.userModels = {};
  }
  config.userModels[userId] = { provider, modelId };
  saveConfig(config);
  return config.userModels[userId];
}

/**
 * Get the default model config
 */
function getDefaultModel() {
  const config = loadConfig();
  return config.defaultModel;
}

/**
 * Set the default model config
 */
function setDefaultModel(provider, modelId) {
  const config = loadConfig();
  config.defaultModel = { provider, modelId };
  saveConfig(config);
  return config.defaultModel;
}

/**
 * Get display name for a model
 */
function getModelDisplayName(provider, modelId) {
  if (provider === "anthropic") {
    const model = ANTHROPIC_MODELS.find((m) => m.id === modelId);
    return model ? model.name : modelId;
  }
  return modelId === "default" ? "LM Studio (default)" : modelId;
}

// Tool definitions
const MODEL_TOOLS = [
  {
    type: "function",
    function: {
      name: "open_model_selection",
      description:
        "Open a modal for the user to select which AI model to use. Use when user wants to change models, switch models, or asks about model settings.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_model",
      description: "Get the current AI model configuration for the user.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

/**
 * Execute model-related tools
 */
function executeModelTool(name, args, userId) {
  switch (name) {
    case "open_model_selection":
      return {
        trigger_modal: "model_selection",
        message: "Click the button below to select your AI model:",
      };

    case "get_current_model": {
      const model = getUserModel(userId);
      const displayName = getModelDisplayName(model.provider, model.modelId);
      return {
        provider: model.provider,
        modelId: model.modelId,
        displayName,
        message: `Current model: ${displayName} (${model.provider})`,
      };
    }

    default:
      throw new Error(`Unknown model tool: ${name}`);
  }
}

module.exports = {
  ANTHROPIC_MODELS,
  MODEL_TOOLS,
  loadConfig,
  saveConfig,
  getUserModel,
  setUserModel,
  getDefaultModel,
  setDefaultModel,
  getModelDisplayName,
  executeModelTool,
};
