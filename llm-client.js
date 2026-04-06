const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

// LM Studio client (OpenAI-compatible)
const lmstudio = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1",
  apiKey: "lm-studio",
  timeout: 1200000, // 20 minute timeout
  maxRetries: 2,
});

// Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Convert OpenAI-format tools to Anthropic format
 */
function convertToolsToAnthropic(openaiTools) {
  return openaiTools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

/**
 * Normalize messages for LM Studio to ensure alternating roles
 * - Merges consecutive same-role messages
 * - Ensures first message after system is user
 * - Ensures proper user/assistant alternation
 */
function normalizeMessagesForLmStudio(messages) {
  const result = [];
  let lastNonToolRole = null;

  for (const msg of messages) {
    // System messages pass through at the start
    if (msg.role === "system") {
      result.push(msg);
      continue;
    }

    // Tool messages pass through (they follow assistant with tool_calls)
    if (msg.role === "tool") {
      result.push(msg);
      continue;
    }

    const lastMsg = result[result.length - 1];

    // Ensure first non-system message is user
    if (lastNonToolRole === null && msg.role === "assistant") {
      // Skip leading assistant messages or convert to context
      continue;
    }

    // Assistant messages with tool_calls pass through
    if (msg.role === "assistant" && msg.tool_calls) {
      result.push(msg);
      lastNonToolRole = "assistant";
      continue;
    }

    // Check if we need to merge with previous message of same role
    if (lastMsg && lastMsg.role === msg.role && lastMsg.role !== "tool" && !lastMsg.tool_calls) {
      lastMsg.content = (lastMsg.content || "") + "\n\n" + (msg.content || "");
      continue;
    }

    // Check for role violation (same role twice without tool in between)
    if (lastNonToolRole === msg.role) {
      // Find the last message of this role and merge
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === msg.role && !result[i].tool_calls) {
          result[i].content = (result[i].content || "") + "\n\n" + (msg.content || "");
          break;
        }
      }
      continue;
    }

    result.push({ ...msg });
    lastNonToolRole = msg.role;
  }

  // Final check: ensure we have at least one user message
  const hasUser = result.some(m => m.role === "user");
  if (!hasUser) {
    // Find position after system message
    const insertIdx = result.findIndex(m => m.role !== "system");
    if (insertIdx === -1) {
      result.push({ role: "user", content: "Hello" });
    } else {
      result.splice(insertIdx, 0, { role: "user", content: "Continue" });
    }
  }

  return result;
}

/**
 * Convert messages for Anthropic API (extract system prompt)
 */
function convertMessagesForAnthropic(messages) {
  const systemMsg = messages.find((m) => m.role === "system");
  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      // Handle tool results from previous iterations
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        };
      }

      // Handle assistant messages with tool calls
      if (m.role === "assistant" && m.tool_calls) {
        const content = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        return { role: "assistant", content };
      }

      // Regular messages
      return {
        role: m.role,
        content: m.content,
      };
    });

  // Merge consecutive tool_result messages into one user message
  const mergedMessages = [];
  for (const msg of conversationMessages) {
    const lastMsg = mergedMessages[mergedMessages.length - 1];
    if (
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content[0]?.type === "tool_result" &&
      lastMsg?.role === "user" &&
      Array.isArray(lastMsg.content) &&
      lastMsg.content[0]?.type === "tool_result"
    ) {
      // Merge into previous user message
      lastMsg.content.push(...msg.content);
    } else {
      mergedMessages.push(msg);
    }
  }

  return {
    system: systemMsg?.content || "",
    messages: mergedMessages,
  };
}

/**
 * Normalize Anthropic response to OpenAI-like format
 */
function normalizeAnthropicResponse(response) {
  const message = {
    role: "assistant",
    content: null,
    tool_calls: null,
  };

  // Extract text content
  const textBlocks = response.content.filter((c) => c.type === "text");
  if (textBlocks.length > 0) {
    message.content = textBlocks.map((b) => b.text).join("");
  }

  // Extract tool calls
  const toolBlocks = response.content.filter((c) => c.type === "tool_use");
  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    }));
  }

  return {
    choices: [
      {
        message,
        finish_reason: response.stop_reason === "tool_use" ? "tool_calls" : "stop",
      },
    ],
  };
}

/**
 * Fetch available models from LM Studio
 */
async function fetchLmStudioModels() {
  try {
    const response = await lmstudio.models.list();
    return response.data.map((m) => ({
      id: m.id,
      name: m.id,
      provider: "lmstudio",
    }));
  } catch (err) {
    console.error("[llm-client] Error fetching LM Studio models:", err.message);
    return [];
  }
}

/**
 * Unified chat completion interface
 */
async function chatCompletion({ provider, modelId, messages, tools, systemPrompt }) {
  if (provider === "lmstudio") {
    // For LM Studio, we need a real model name - fetch the first available if "default"
    let actualModel = modelId;
    if (modelId === "default") {
      // Try env var first, then fetch from LM Studio
      if (process.env.LM_STUDIO_MODEL) {
        actualModel = process.env.LM_STUDIO_MODEL;
      } else {
        // Fetch available models and use the first one
        const models = await fetchLmStudioModels();
        if (models.length > 0) {
          actualModel = models[0].id;
        } else {
          throw new Error("No models available in LM Studio. Please load a model.");
        }
      }
    }

    // Normalize messages to ensure alternating roles
    const normalizedMessages = normalizeMessagesForLmStudio(messages);

    // Debug: log message roles
    console.log("[llm-client] Message roles:", normalizedMessages.map(m =>
      m.role + (m.tool_calls ? "(tools)" : "") + (m.role === "tool" ? `[${m.tool_call_id?.slice(-4)}]` : "")
    ).join(" → "));

    return await lmstudio.chat.completions.create({
      model: actualModel,
      messages: normalizedMessages,
      tools,
      tool_choice: "auto",
    });
  }

  if (provider === "anthropic") {
    const anthropicTools = convertToolsToAnthropic(tools);
    const { system, messages: anthropicMessages } = convertMessagesForAnthropic(messages);

    const response = await anthropic.messages.create({
      model: modelId,
      max_tokens: 8192,
      system: system || systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools,
    });

    return normalizeAnthropicResponse(response);
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Check if Anthropic API key is configured
 */
function hasAnthropicKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Check if LM Studio is available
 */
async function isLmStudioAvailable() {
  try {
    await lmstudio.models.list();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  chatCompletion,
  fetchLmStudioModels,
  convertToolsToAnthropic,
  hasAnthropicKey,
  isLmStudioAvailable,
  lmstudio,
  anthropic,
};
