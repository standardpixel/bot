require("dotenv").config();
const { App } = require("@slack/bolt");
const express = require('express');
const cors = require('cors');
const { TOOLS, executeTool } = require("./obsidian");
const { CALENDAR_TOOLS, executeCalendarTool } = require("./calendar");
const { BRIEFING_TOOLS, executeBriefingTool } = require("./briefing");
const { LINKS_TOOLS, executeLinksTool } = require("./links");
const { STABLE_DIFFUSION_TOOLS, executeStableDiffusionTool } = require("./stable-diffusion");
const { AOL1995_TOOLS, executeAOL1995Tool } = require("./aol1995");
const { AOL_SHORTCUT_TOOLS, executeAOLShortcutTool } = require("./aol-shortcut");
const { AOL_ALL_TOOLS, executeAOLAllTool } = require("./aol-all");
const { AOL_STATUS_TOOLS, executeAOLStatusTool } = require("./aol-status");
const { AOL_STOP_TOOLS, executeAOLStopTool } = require("./aol-stop");
const { SCHEDULE_TOOLS, executeSchedulerTool, initScheduler, handleModalSubmission, getSchedulesByUser, getScheduleById } = require("./scheduler");
const { getScheduleModal, getManageSchedulesModal, getModelSelectionModal } = require("./modals");
const { MODEL_TOOLS, getUserModel, setUserModel, executeModelTool, getModelDisplayName } = require("./model-config");
const { ENTITY_LINKER_TOOLS, executeEntityLinkerTool } = require("./entity-linker");
const { TEXT_TO_SPEECH_TOOLS, executeTextToSpeechTool } = require("./text-to-speech");
const { chatCompletion, fetchLmStudioModels, hasAnthropicKey, lmstudio } = require("./llm-client");
const { ensureAppsRunning } = require("./app-launcher");
const { processMessage, getSystemPrompt, ALL_TOOLS, executeToolByName, describeToolCall } = require("./message-processor");
const httpRoutes = require('./http-routes');

// HTTP Server setup
const httpApp = express();
const HTTP_PORT = process.env.HTTP_PORT || 8000;

httpApp.use(cors()); // Allow cross-origin requests (for development)
httpApp.use(express.json()); // Parse JSON bodies
httpApp.use('/', httpRoutes);

// Start HTTP server
httpApp.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP API server listening on port ${HTTP_PORT}`);
  console.log(`   Accessible via Tailscale at http://<tailscale-ip>:${HTTP_PORT}/chat`);
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Modal submission handlers
app.view("schedule_modal_submit", async ({ ack, body, view, client }) => {
  await ack();
  await handleModalSubmission(body, view, client, lmstudio, getSystemPrompt(), ALL_TOOLS, executeToolByName, false);
});

app.view("edit_schedule_modal_submit", async ({ ack, body, view, client }) => {
  await ack();
  await handleModalSubmission(body, view, client, lmstudio, getSystemPrompt(), ALL_TOOLS, executeToolByName, true);
});

// Button handler for opening schedule modal (workaround for trigger_id)
app.action("open_schedule_modal_button", async ({ ack, body, client }) => {
  await ack();
  const modal = getScheduleModal();
  await client.views.open({ trigger_id: body.trigger_id, view: modal });
});

app.action("open_manage_schedules_button", async ({ ack, body, client }) => {
  await ack();
  const schedules = getSchedulesByUser(body.user.id);
  const modal = getManageSchedulesModal(schedules);
  await client.views.open({ trigger_id: body.trigger_id, view: modal });
});

// Edit schedule button handler
app.action(/^edit_schedule_/, async ({ ack, body, client }) => {
  await ack();
  const scheduleId = body.actions[0].action_id.replace("edit_schedule_", "");
  const schedule = getScheduleById(scheduleId);
  if (schedule) {
    const modal = getScheduleModal(schedule);
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  }
});

// Delete schedule action handler
app.action(/^delete_schedule_/, async ({ ack, body, client }) => {
  await ack();
  const scheduleId = body.actions[0].action_id.replace("delete_schedule_", "");
  const { deleteSchedule } = require("./scheduler");
  await deleteSchedule(scheduleId);
  await client.chat.postMessage({
    channel: body.user.id,
    text: "✅ Schedule deleted successfully."
  });
});

// Model selection modal submission handler
app.view("model_selection_submit", async ({ ack, body, view, client }) => {
  await ack();

  const userId = body.user.id;
  const modelValue = view.state.values.model_block.model_select.selected_option.value;
  const [provider, modelId] = modelValue.split(":");

  setUserModel(userId, provider, modelId);
  const displayName = getModelDisplayName(provider, modelId);

  await client.chat.postMessage({
    channel: userId,
    text: `✅ Model updated to *${displayName}* (${provider})`
  });
});

// Button handler for model selection modal
app.action("open_model_selection_button", async ({ ack, body, client }) => {
  await ack();

  // Fetch LM Studio models dynamically
  let lmStudioModels = [];
  try {
    lmStudioModels = await fetchLmStudioModels();
  } catch (err) {
    console.log("[model] Could not fetch LM Studio models:", err.message);
  }

  const currentModel = getUserModel(body.user.id);
  const modal = getModelSelectionModal(currentModel, lmStudioModels, hasAnthropicKey());
  await client.views.open({ trigger_id: body.trigger_id, view: modal });
});

const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || "20", 10);
const RECENT_MESSAGES_FOCUS = parseInt(process.env.RECENT_MESSAGES_FOCUS || "10", 10);

// Convert a block of markdown table lines into Slack-friendly text.
// 2-column tables → "*Key:* Value" pairs. Wider tables → bold header row + data rows.
function convertTable(lines) {
  const isSeparator = (l) => /^\|[\s|:=-]+\|$/.test(l.trim());
  const dataLines = lines.filter((l) => l.trim().startsWith("|") && !isSeparator(l));
  const rows = dataLines.map((l) =>
    l.split("|").slice(1, -1).map((cell) => cell.trim())
  );
  if (rows.length === 0) return "";
  const [headers, ...body] = rows;
  if (headers.length === 2 && body.length > 0) {
    // Key-value layout
    return body.map((r) => `*${r[0]}:* ${r[1] ?? ""}`).join("\n");
  }
  // Multi-column layout
  const headerLine = headers.map((h) => `*${h}*`).join(" | ");
  const rowLines = body.map((r) => r.join(" | "));
  return [headerLine, ...rowLines].join("\n");
}

// Detect and replace all markdown table blocks in text before other processing.
function stripTables(text) {
  const lines = text.split("\n");
  const out = [];
  let tableLines = [];
  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      tableLines.push(line);
    } else {
      if (tableLines.length) { out.push(convertTable(tableLines)); tableLines = []; }
      out.push(line);
    }
  }
  if (tableLines.length) out.push(convertTable(tableLines));
  return out.join("\n");
}

// Convert standard Markdown to Slack mrkdwn, then build Block Kit blocks.
// Handles models that output Markdown regardless of prompting.
function toSlackMessage(text) {
  const mrkdwn = stripTables(text)
    .trim()
    // Headers → bold line (## Meeting Prep → *Meeting Prep*)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // **bold** and __bold__ → *bold*
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/__(.+?)__/gs, "*$1*")
    // Strip any HTML tags
    .replace(/<[^>]+>/g, "")
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, "\n\n");

  // Split into Block Kit section blocks (max 3000 chars each)
  const MAX = 3000;
  const blocks = [];
  let remaining = mrkdwn;
  while (remaining.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: remaining.slice(0, MAX) },
    });
    remaining = remaining.slice(MAX);
  }

  return { blocks, text: text.slice(0, 150) }; // text = notification fallback
}

// Post a regular status message; returns its ts for later update/delete
async function postStatus(client, channel, text) {
  try {
    const res = await client.chat.postMessage({ channel, text });
    return res.ts;
  } catch (err) {
    console.error("[postStatus]", err.message);
    return null;
  }
}

async function updateStatus(client, channel, ts, text) {
  if (!ts) return;
  try {
    await client.chat.update({ channel, ts, text });
  } catch (err) {
    console.error("[updateStatus]", err.message);
  }
}

async function deleteStatus(client, channel, ts) {
  if (!ts) return;
  try {
    await client.chat.delete({ channel, ts });
  } catch (err) {
    console.error("[deleteStatus]", err.message);
  }
}

// Download image from Slack
async function downloadSlackImage(url, token) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

// Extract text from image using vision model via LM Studio
async function extractTextFromImage(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString('base64');
  const imageUrl = `data:${mimeType};base64,${base64Image}`;

  try {
    const response = await lmstudio.chat.completions.create({
      model: "mistralai/devstral-small-2-2512",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract all text from this image. If it contains handwritten notes, transcribe them carefully. Return only the extracted text, without any commentary or formatting."
            },
            {
              type: "image_url",
              image_url: {
                url: imageUrl
              }
            }
          ]
        }
      ],
      max_tokens: 2000,
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error("[OCR Error]", err.message);
    throw new Error(`Failed to extract text from image: ${err.message}`);
  }
}

app.message(async ({ message, client, say }) => {
  if (message.channel_type !== "im" || message.bot_id) return;

  // Don't skip messages with files subtype
  if (message.subtype && message.subtype !== 'file_share') return;

  const { channel, thread_ts, ts } = message;
  let text = (message.text || "").toLowerCase();

  // Check if message has image attachments
  let extractedText = null;
  if (message.files && message.files.length > 0) {
    const imageFile = message.files.find(f => f.mimetype && f.mimetype.startsWith('image/'));
    if (imageFile) {
      try {
        await client.reactions.add({
          channel,
          timestamp: ts,
          name: 'eyes'
        });

        const imageBuffer = await downloadSlackImage(imageFile.url_private, process.env.SLACK_BOT_TOKEN);
        extractedText = await extractTextFromImage(imageBuffer, imageFile.mimetype);

        await client.reactions.remove({
          channel,
          timestamp: ts,
          name: 'eyes'
        });
        await client.reactions.add({
          channel,
          timestamp: ts,
          name: 'white_check_mark'
        });

        // Replace the message text with extracted text for processing
        text = extractedText.toLowerCase();
        console.log('[OCR] Extracted text from image:', extractedText);
      } catch (err) {
        console.error('[OCR] Failed to process image:', err.message);
        await client.reactions.remove({
          channel,
          timestamp: ts,
          name: 'eyes'
        });
        await client.reactions.add({
          channel,
          timestamp: ts,
          name: 'x'
        });
        await say(`I couldn't extract text from that image. Error: ${err.message}\n\nMake sure:\n• LM Studio is running\n• The model \`mistralai/devstral-small-2-2512\` is loaded\n• The local server is started`);
        return;
      }
    }
  }

  // Direct command: change/switch model - bypass LLM entirely
  if (/\b(change|switch|select|set)\s+(my\s+)?(model|llm|ai)\b/.test(text) ||
      /\bmodel\s+(selection|settings|config)\b/.test(text)) {
    // Fetch LM Studio models
    let lmStudioModels = [];
    try {
      lmStudioModels = await fetchLmStudioModels();
    } catch (err) {
      console.log("[model] Could not fetch LM Studio models:", err.message);
    }

    const currentModel = getUserModel(message.user);
    const modal = getModelSelectionModal(currentModel, lmStudioModels, hasAnthropicKey());

    // Post button to open modal (can't open modal directly without trigger_id from interaction)
    await client.chat.postMessage({
      channel,
      text: "Click the button below to select your AI model:",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Click the button below to select your AI model:"
          }
        },
        {
          type: "actions",
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "Select Model" },
            action_id: "open_model_selection_button",
            style: "primary"
          }]
        }
      ]
    });
    return;
  }

  let statusTs = null;
  try {
    // If in a thread, get thread history; otherwise get channel history
    let history;
    if (thread_ts) {
      history = await client.conversations.replies({
        channel,
        ts: thread_ts,
        limit: HISTORY_LIMIT
      });
    } else {
      history = await client.conversations.history({ channel, limit: HISTORY_LIMIT });
    }

    statusTs = await postStatus(client, channel, "Thinking...");

    // Use only the most recent messages to avoid overwhelming the model
    const recentMessages = history.messages
      .filter((m) => !m.subtype)
      .reverse()
      .slice(-RECENT_MESSAGES_FOCUS);

    // Build conversation history for processMessage
    const conversationHistory = recentMessages
      .slice(0, -1) // Exclude the current message
      .map((m) => {
        let content = m.text || "";
        // Truncate very long messages in history to save context
        if (content.length > 500) {
          content = content.slice(0, 500) + "... [truncated]";
        }
        return {
          role: m.bot_id ? "assistant" : "user",
          content
        };
      })
      .filter((m) => m.content && m.content.trim().length > 0); // Filter out empty messages

    // Get user's model preference
    const userModel = getUserModel(message.user);
    console.log(`[model] Using ${userModel.provider}:${userModel.modelId} for user ${message.user}`);

    // Get the current message text (use extracted text from OCR if available)
    const messageText = extractedText || message.text || "";

    // Call the shared message processor
    const result = await processMessage({
      messageText,
      conversationHistory,
      userId: message.user,
      userModel,
      statusCallback: async (status) => {
        await updateStatus(client, channel, statusTs, status);
      }
    });

    await deleteStatus(client, channel, statusTs);

    if (result.success) {
      await say(toSlackMessage(result.response));
    } else {
      await say(`Error: ${result.error}`);
    }
  } catch (err) {
    console.error("Error:", err.message);
    await deleteStatus(client, channel, statusTs);
    await say(`Error: ${err.message}`);
  }
});

(async () => {
  await app.start();
  await initScheduler(app.client, lmstudio, getSystemPrompt(), ALL_TOOLS, executeToolByName);
  console.log("sp-bot is running");
})();
