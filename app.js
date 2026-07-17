require("dotenv").config();
const { App } = require("@slack/bolt");
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

const ALL_TOOLS = [...TOOLS, ...CALENDAR_TOOLS, ...BRIEFING_TOOLS, ...LINKS_TOOLS, ...STABLE_DIFFUSION_TOOLS, ...AOL1995_TOOLS, ...AOL_SHORTCUT_TOOLS, ...AOL_ALL_TOOLS, ...AOL_STATUS_TOOLS, ...AOL_STOP_TOOLS, ...SCHEDULE_TOOLS, ...MODEL_TOOLS, ...ENTITY_LINKER_TOOLS, ...TEXT_TO_SPEECH_TOOLS];

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Helper function to execute tools (used by both message handler and scheduler)
async function executeToolByName(toolName, args) {
  if (toolName.startsWith("get_calendar") || toolName === "check_calendar_conflicts" || toolName === "create_calendar_event" || toolName === "update_calendar_event" || toolName === "delete_calendar_event") {
    return await executeCalendarTool(toolName, args);
  } else if (toolName.startsWith("run_daily")) {
    return await executeBriefingTool(toolName);
  } else if (toolName === "add_article" || toolName === "deploy_links") {
    return executeLinksTool(toolName, args);
  } else if (toolName === "start_stable_diffusion") {
    return executeStableDiffusionTool(toolName, args);
  } else if (toolName === "start_aol1995_server") {
    return executeAOL1995Tool(toolName, args);
  } else if (toolName === "start_aol_shortcut") {
    return executeAOLShortcutTool(toolName, args);
  } else if (toolName === "start_all_aol_services") {
    return executeAOLAllTool(toolName, args);
  } else if (toolName === "check_aol_services_status") {
    return executeAOLStatusTool(toolName, args);
  } else if (toolName === "stop_aol_services") {
    return executeAOLStopTool(toolName, args);
  } else if (toolName.startsWith("link_entities")) {
    return await executeEntityLinkerTool(toolName, args);
  } else {
    return executeTool(toolName, args);
  }
}

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

function getSystemPrompt() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    process.env.SYSTEM_PROMPT ||
    `Today is ${today}. ` +
    "You are a helpful, knowledgeable assistant. " +
  "You have access to an Obsidian vault, macOS Calendar, and scheduling capabilities via tools. " +
  "When the user asks to schedule something, use open_schedule_modal. When they want to view or manage their schedules, use open_manage_schedules. " +
  "When the user asks about a person, place, project, topic, or concept — always search the vault first using search_notes before responding. " +
  "If results are found, read the most relevant notes and summarize what you find. " +
  "Only say you don't have information after you have searched and found nothing. " +
  "Never save tool results (briefings, search results, calendar data) to the vault — just present them in your reply. " +
  "When referencing a note, mention its file path.\n\n" +
  "VAULT ORGANIZATION: The vault uses the PARA method:\n" +
  "- Projects/ — Active projects with specific goals and deadlines\n" +
  "- Areas/ — Ongoing areas of responsibility (e.g., Areas/Health, Areas/Finance)\n" +
  "- Resources/ — Reference material and information on topics of interest\n" +
  "- Archives/ — Completed projects and inactive items\n" +
  "- Daily notes are in the root as YYYY-MM-DD.md\n" +
  "- People notes are in Resources/People/\n" +
  "- Company notes are in Resources/Companies/\n" +
  "When creating notes, place them in the appropriate PARA folder based on their purpose.\n\n" +
  "QUICK NOTES: When the user sends a casual update mentioning people, projects, meetings, or events, proactively capture it:\n" +
  "1. *Detect note-worthy messages* — Look for mentions of people, projects, meetings, conversations, commitments, progress updates, or new contacts.\n" +
  "2. *Match existing people or projects* — Search the vault for the person's name or project name. Use context clues (company, role, location for people; keywords for projects) to disambiguate. Read the top match to verify it's correct.\n" +
  "3. *Append to existing notes* — If a match is found, append a timestamped entry:\n" +
  "   Format: `\\n\\n### YYYY-MM-DD\\n[Your summary of the update]`\n" +
  "4. *Create new notes when appropriate*:\n" +
  "   - New people → `Resources/People/Firstname Lastname.md`\n" +
  "   - New projects (if user explicitly mentions starting one) → `Projects/Project Name.md`\n" +
  "5. *Confirm briefly* — After updating/creating, confirm with a short message like: 'Added to Andrew Chen's note' or 'Updated Website Redesign project'\n" +
  "6. *Don't over-ask* — If the intent is clear, just do it. Only ask for clarification if there are multiple matches or ambiguity.\n" +
  "Examples of note-worthy messages:\n" +
  "- 'Just met with Andrew from Slack, he'll get back to me next week' → Find Andrew (Slack context), append update\n" +
  "- 'Met the new neighbor James Lee at 80 Bennit' → Create Resources/People/James Lee.md\n" +
  "- 'Sarah mentioned she's moving to NYC in March' → Find Sarah, append update\n" +
  "- 'Made progress on the website redesign - finished the homepage mockups' → Find website redesign project, append update\n" +
  "- 'The API migration is blocked waiting on legal' → Find API migration project, append update\n\n" +
  "MODIFYING NOTES: You can now modify existing note content using update_note and replace_in_note:\n" +
  "- *update_note* — Replaces the entire content of a note. Use when rewriting or restructuring a note.\n" +
  "- *replace_in_note* — Finds and replaces specific text within a note. Use for targeted edits.\n" +
  "- *When to modify vs append:*\n" +
  "  • For quick updates and new information → use append_to_note\n" +
  "  • When the user explicitly asks to 'update', 'change', 'fix', or 'rewrite' something → use update_note or replace_in_note\n" +
  "  • When restructuring or cleaning up a note → use update_note\n" +
  "- *Safety first:* ALWAYS read the note first before modifying it. Never modify a note you haven't read.\n" +
  "- *User confirmation:* When making significant changes, ask the user to confirm before using these tools.\n" +
  "- *Avoid duplicates:* If a note already exists and the user wants to add info, modify it - don't create a duplicate with -1 suffix.\n\n" +
  "IMAGE OCR: When the user uploads an image (such as a photo of handwritten notes), the text will be automatically extracted using OCR and processed as if it were a text message. Treat extracted text from images the same as typed messages — apply the QUICK NOTES logic to capture information to the vault.\n\n" +
  "VAULT BACKUP: When the user says 'commit my vault' or asks to backup/commit their vault, use the commit_vault tool. This commits all changes and pushes to the remote repository. This is particularly useful before performing potentially destructive operations on the vault.\n\n" +
  "FORMATTING: You are responding inside Slack. Use Slack mrkdwn formatting only:\n" +
  "- *bold* for bold text (single asterisks)\n" +
  "- _italic_ for italic text\n" +
  "- Section headers as a bold line on its own: *Header*\n" +
  "- Bullet points with a dash: - item\n" +
  "- `inline code` and ```code blocks``` as normal\n" +
  "- Never use ## or ### markdown headers\n" +
  "- Never use ** for bold\n" +
  "- Never use HTML tags\n\n" +
  "DAILY NOTES: When the user asks to create or add to a daily note without providing content, ask them what they would like to add before calling write_daily_note. " +
  "Always use write_daily_note (never create_note) for daily notes — it appends safely if the file already exists.\n\n" +
  "CALENDAR MANAGEMENT: You can read, create, update, and delete calendar events:\n" +
  "- *get_calendar_events* — View upcoming events\n" +
  "- *create_calendar_event* — Add new events (always check for conflicts first)\n" +
  "  • If the user doesn't specify which calendar, the default calendar will be used automatically\n" +
  "  • Only ask which calendar if the user explicitly mentions needing to choose (e.g., 'Should I add this to Work or Personal?')\n" +
  "- *update_calendar_event* — Modify existing events (title, time, duration, or notes)\n" +
  "- *delete_calendar_event* — Remove events from the calendar\n" +
  "- *Safety for destructive actions:* ALWAYS confirm with the user before updating or deleting calendar events\n" +
  "  • Use confirm=true parameter first to preview what will change\n" +
  "  • Show the user the preview and ask for confirmation\n" +
  "  • Only proceed with the actual update/delete after user confirms\n" +
  "- *Exception:* If the user explicitly says 'delete [event]' or 'update [event] to [new details]', you can still preview first but the intent is clear\n\n" +
  "MEETING PREP: When the user asks to prepare for a meeting with someone, follow these steps:\n" +
  "1. Call get_calendar_events to find the meeting details and other attendees.\n" +
  "2. Search the vault for notes about the person (try Resources/People/).\n" +
  "3. Read any matching notes in full.\n" +
  "4. Look for their company in the notes and search for it (try Resources/Companies/).\n" +
  "5. Search for recent mentions of the person in daily notes or elsewhere.\n" +
  "6. Synthesize everything into a structured briefing with sections: Meeting Details, About [Person], About [Company], Recent Context, and Suggested Topics."
  );
}

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

// Human-readable description of what each tool call is doing
function describeToolCall(name, args) {
  switch (name) {
    case "search_notes":    return `Searching vault for "${args.query}"...`;
    case "read_note":       return `Reading note: ${args.path}`;
    case "list_vault":      return `Listing vault${args.folder ? `: ${args.folder}` : ""}...`;
    case "create_note":     return `Creating note: ${args.path}`;
    case "append_to_note":        return `Appending to note: ${args.path}`;
    case "update_note":           return args.confirm ? `Previewing update to: ${args.path}` : `Updating note: ${args.path}`;
    case "replace_in_note":       return args.confirm ? `Previewing replacement in: ${args.path}` : `Replacing text in: ${args.path}`;
    case "write_daily_note":      return `Writing to daily note...`;
    case "archive_note":          return `Archiving note: ${args.path}...`;
    case "commit_vault":          return `Committing vault changes to git...`;
    case "add_article":           return `Adding article and deploying to standardpixel.com...`;
    case "deploy_links":          return `Syncing and deploying links page...`;
    case "get_calendar_events":   return `Checking calendar...`;
    case "get_calendar_names":    return `Getting available calendars...`;
    case "check_calendar_conflicts": return `Checking for scheduling conflicts...`;
    case "create_calendar_event": return `Creating calendar event: ${args.title}...`;
    case "update_calendar_event": return args.confirm ? `Previewing update to event: ${args.title}` : `Updating calendar event: ${args.title}...`;
    case "delete_calendar_event": return args.confirm ? `Previewing deletion of event: ${args.title}` : `Deleting calendar event: ${args.title}...`;
    case "run_daily_briefing":    return `Triggering briefing plugin — this can take a few minutes...`;
    case "start_stable_diffusion": return `Starting Stable Diffusion WebUI with API...`;
    case "start_aol1995_server":  return `Starting AOL 1995 server with HTTPS on port 3010...`;
    case "start_aol_shortcut":    return `Running AOL shortcut...`;
    case "start_all_aol_services": return `Starting all AOL services (Shortcut, Stable Diffusion, AOL 1995)...`;
    case "check_aol_services_status": return `Checking status of AOL services...`;
    case "stop_aol_services":     return `Stopping AOL services...`;
    case "open_schedule_modal":   return `Opening schedule configuration...`;
    case "open_manage_schedules": return `Loading your schedules...`;
    case "list_schedules":        return `Fetching your schedules...`;
    case "delete_schedule":       return `Deleting schedule...`;
    case "open_model_selection":  return `Opening model selection...`;
    case "get_current_model":     return `Checking current model...`;
    case "link_entities_in_note": return `Linking entities in note${args.notePath ? `: ${args.notePath}` : ""}...`;
    case "link_entities_in_recent_notes": return `Linking entities in recent notes — this may take several minutes...`;
    case "read_note_aloud":       return `Generating audio for ${args.path}...`;
    default:                      return `Running ${name}...`;
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

    const messages = [
      { role: "system", content: getSystemPrompt() },
      ...recentMessages
        .map((m, idx) => {
          let content = m.text || "";
          // If this is the current message and we extracted text, use that instead
          if (m.ts === ts && extractedText) {
            content = extractedText;
          }
          // Truncate very long messages in history to save context (but not the current message)
          if (content.length > 500 && m.ts !== ts) {
            content = content.slice(0, 500) + "... [truncated]";
          }
          return { role: m.bot_id ? "assistant" : "user", content };
        })
        .filter((m) => m.content && m.content.trim().length > 0), // Filter out empty messages
    ];

    // Ensure the conversation ends with a user message (required for Anthropic API)
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "assistant") {
      // Remove trailing assistant messages - the current user message will be the last one
      while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages.pop();
      }
    }

    // Get user's model preference
    const userModel = getUserModel(message.user);
    console.log(`[model] Using ${userModel.provider}:${userModel.modelId} for user ${message.user}`);

    // Ensure Obsidian and LM Studio are running before processing
    try {
      const launchedApps = await ensureAppsRunning();
      if (launchedApps.length > 0) {
        console.log(`[app-launcher] Launched apps: ${launchedApps.join(", ")}`);
      }
    } catch (err) {
      console.error("[app-launcher] Failed to launch required apps:", err.message);
      await deleteStatus(client, channel, statusTs);
      await say(`Failed to launch required applications: ${err.message}\n\nPlease ensure Obsidian and LM Studio are installed in your Applications folder.`);
      return;
    }

    // Track tool calls to detect loops (only for LM Studio models)
    const toolCallHistory = [];
    const LOOP_THRESHOLD = 2; // Same tool+args called this many times = loop
    const NUDGE_AFTER_ITERATIONS = 7; // Nudge model to respond after this many tool-only iterations
    let wasNudged = false; // Track if we had to intervene

    function detectLoop(toolName, args) {
      // Only enforce loop detection for LM Studio models
      // Anthropic models are clever enough to detect and handle loops themselves
      if (userModel.provider !== "lmstudio") {
        return false;
      }

      const signature = `${toolName}:${JSON.stringify(args)}`;
      toolCallHistory.push(signature);
      const count = toolCallHistory.filter(s => s === signature).length;
      return count >= LOOP_THRESHOLD;
    }

    // Track which vault-modifying tools were actually called
    const vaultToolsCalled = new Set();

    const MAX_ITERATIONS = 10;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // After many iterations with no response, nudge the model (only for LM Studio)
      if (i === NUDGE_AFTER_ITERATIONS && userModel.provider === "lmstudio") {
        console.log(`[loop-detection] Nudging LM Studio model after ${i} iterations with no text response`);
        wasNudged = true;
        messages.push({
          role: "user",
          content: "Please provide your response now based on what you've found. Summarize the information and answer the original question."
        });
      }
      let response;
      try {
        response = await chatCompletion({
          provider: userModel.provider,
          modelId: userModel.modelId,
          messages,
          tools: ALL_TOOLS,
          systemPrompt: getSystemPrompt(),
        });
      } catch (apiErr) {
        console.error("[API Error]", apiErr.message);
        await deleteStatus(client, channel, statusTs);
        const providerName = userModel.provider === "anthropic" ? "Anthropic" : "LM Studio";
        await say(`Unable to reach ${providerName}. ${userModel.provider === "lmstudio" ? "Please make sure:\n• LM Studio is running\n• A model is loaded\n• The local server is started" : "Please check your API key."}\n\nError: ${apiErr.message}`);
        return;
      }

      const choice = response.choices[0];
      if (!choice || !choice.message) {
        console.error("[Empty response from model]");
        await deleteStatus(client, channel, statusTs);
        await say("Received an empty response from the model. This sometimes happens when the model is overloaded. Please try again.");
        return;
      }
      messages.push(choice.message);

      if (choice.finish_reason !== "tool_calls") {
        await deleteStatus(client, channel, statusTs);
        statusTs = null;
        let responseContent = choice.message.content || "No response from model.";

        // Validate: detect if model claims vault modifications without calling tools
        const claimsArchive = /\b(archived|moved to (the )?archive|moved .+ to archive)\b/i.test(responseContent);
        const claimsCreated = /\b(created|added) (a |the )?(new )?(note|file)\b/i.test(responseContent);
        const claimsUpdated = /\b(updated|appended|added to|wrote to) (the )?(note|file|daily note)\b/i.test(responseContent);

        const claimsVaultChange = claimsArchive || claimsCreated || claimsUpdated;
        const noVaultToolsCalled = vaultToolsCalled.size === 0;

        if (claimsVaultChange && noVaultToolsCalled) {
          console.log("[hallucination-detected] Model claimed vault change but no tools were called");
          responseContent += "\n\n:warning: *Warning: The model claimed to modify your vault but no tools were actually called. This can happen with some local models that don't support tool calling well. The action was NOT performed.*";
        }

        // Add note if we had to nudge the model
        if (wasNudged) {
          responseContent += "\n\n_Note: The model wanted to continue searching but was limited. This response may be less complete than usual._";
        }
        await say(toSlackMessage(responseContent));
        break;
      }

      const toolResults = [];
      let loopDetected = false;

      for (const call of choice.message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function.arguments);
          await updateStatus(client, channel, statusTs, describeToolCall(call.function.name, args));
          console.log(`[tool] ${call.function.name}`, args);

          // Track vault-modifying tools
          if (["create_note", "append_to_note", "update_note", "replace_in_note", "write_daily_note", "archive_note"].includes(call.function.name)) {
            vaultToolsCalled.add(call.function.name);
          }

          // Check for repetitive tool calling (loop detection)
          if (detectLoop(call.function.name, args)) {
            console.log(`[loop-detection] Detected repeated call: ${call.function.name} with same args`);
            loopDetected = true;
            wasNudged = true;
            result = "You've already called this tool with these arguments. Please provide your response based on the information you've gathered.";
            toolResults.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
            continue;
          }

          if (call.function.name.startsWith("open_schedule") ||
              call.function.name.startsWith("open_manage") ||
              call.function.name === "list_schedules" ||
              call.function.name === "delete_schedule") {
            result = executeSchedulerTool(call.function.name, args, message.user);

            // If it's a modal trigger, post a message with a button
            if (result.trigger_modal) {
              await deleteStatus(client, channel, statusTs);
              statusTs = null;

              const buttonText = result.trigger_modal === "schedule" ? "Schedule Task" : "Manage Schedules";
              const actionId = result.trigger_modal === "schedule" ? "open_schedule_modal_button" : "open_manage_schedules_button";

              await client.chat.postMessage({
                channel,
                text: result.message,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: result.message
                    }
                  },
                  {
                    type: "actions",
                    elements: [{
                      type: "button",
                      text: { type: "plain_text", text: buttonText },
                      action_id: actionId,
                      style: "primary"
                    }]
                  }
                ]
              });

              result = "Modal button sent to user";
            }
          } else if (call.function.name.startsWith("get_calendar") || call.function.name === "check_calendar_conflicts" || call.function.name === "create_calendar_event" || call.function.name === "update_calendar_event" || call.function.name === "delete_calendar_event") {
            result = await executeCalendarTool(call.function.name, args);
          } else if (call.function.name.startsWith("run_daily")) {
            result = await executeBriefingTool(call.function.name);
          } else if (call.function.name === "add_article" || call.function.name === "deploy_links") {
            result = executeLinksTool(call.function.name, args);
          } else if (call.function.name === "start_stable_diffusion") {
            result = executeStableDiffusionTool(call.function.name, args);
          } else if (call.function.name === "start_aol1995_server") {
            result = executeAOL1995Tool(call.function.name, args);
          } else if (call.function.name === "start_aol_shortcut") {
            result = executeAOLShortcutTool(call.function.name, args);
          } else if (call.function.name === "start_all_aol_services") {
            result = executeAOLAllTool(call.function.name, args);
          } else if (call.function.name === "check_aol_services_status") {
            result = executeAOLStatusTool(call.function.name, args);
          } else if (call.function.name === "stop_aol_services") {
            result = executeAOLStopTool(call.function.name, args);
          } else if (call.function.name.startsWith("link_entities")) {
            result = await executeEntityLinkerTool(call.function.name, args);
          } else if (call.function.name === "read_note_aloud") {
            result = await executeTextToSpeechTool(call.function.name, args, client, channel);
          } else if (call.function.name === "open_model_selection" || call.function.name === "get_current_model") {
            result = executeModelTool(call.function.name, args, message.user);

            // If it's a modal trigger, post a message with a button and stop
            if (result.trigger_modal) {
              await deleteStatus(client, channel, statusTs);

              await client.chat.postMessage({
                channel,
                text: result.message,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: result.message
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

              // Stop processing - user needs to interact with modal
              return;
            }
          } else {
            result = executeTool(call.function.name, args);
          }
        } catch (err) {
          console.error(`[tool error: ${call.function.name}]`, err.message, err.stack);

          // Provide specific error messages based on tool type
          let errorMessage = err.message;
          if (call.function.name.startsWith("search_notes") ||
              call.function.name.startsWith("read_note") ||
              call.function.name.startsWith("list_vault") ||
              call.function.name.startsWith("write_") ||
              call.function.name.startsWith("append_") ||
              call.function.name.startsWith("create_note")) {
            if (err.message.includes("OBSIDIAN_VAULT_PATH")) {
              errorMessage = "Obsidian vault path is not configured. Please check your .env file.";
            } else if (err.message.includes("ENOENT") || err.message.includes("not found")) {
              errorMessage = `Could not access the vault or file. The path may not exist or may not be synced via iCloud yet. Error: ${err.message}`;
            } else {
              errorMessage = `Vault error: ${err.message}`;
            }
          } else if (call.function.name.startsWith("get_calendar") || call.function.name === "check_calendar_conflicts" || call.function.name === "create_calendar_event") {
            if (err.message.includes("timeout")) {
              errorMessage = "Calendar request timed out. The Calendar app may be unresponsive.";
            } else {
              errorMessage = `Calendar error: ${err.message}. Make sure Terminal has Calendar access in System Settings → Privacy & Security → Calendars.`;
            }
          }

          result = `Error: ${errorMessage}`;
        }
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      messages.push(...toolResults);

      // If loop detected, add a stronger nudge
      if (loopDetected) {
        messages.push({
          role: "user",
          content: "You seem to be calling the same tools repeatedly. Please stop and provide your response now with the information you have."
        });
      }

      await updateStatus(client, channel, statusTs, "Thinking...");
    }

    // If we exhausted all iterations without a response
    if (statusTs) {
      console.log("[loop-detection] Max iterations reached without text response");
      await deleteStatus(client, channel, statusTs);
      await say("The model made many tool calls but didn't provide a final response. This can happen with some models. Try a different model or rephrase your question.");
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
