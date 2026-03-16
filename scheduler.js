/**
 * Scheduler module for sp-bot
 * Handles schedule CRUD, job management, and scheduled prompt execution
 */

const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const { v4: uuidv4 } = require("uuid");
const { getScheduleModal } = require("./modals");

const SCHEDULES_FILE = path.join(__dirname, "schedules.json");

// In-memory job registry
const activeJobs = new Map();

// Tool definitions for the LLM
const SCHEDULE_TOOLS = [
  {
    type: "function",
    function: {
      name: "open_schedule_modal",
      description: "Open a modal for the user to schedule a task. Use this when the user wants to schedule something or create a new schedule.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_manage_schedules",
      description: "Open a modal showing all of the user's schedules with options to edit or delete. Use this when the user wants to view, update, manage, or see their schedules.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_schedules",
      description: "Get a list of all schedules for the user in text format. Use this when the user asks 'what are my schedules' in conversation.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_schedule",
      description: "Delete a specific schedule by ID. Use only when user explicitly requests deletion by referencing a specific schedule.",
      parameters: {
        type: "object",
        properties: {
          scheduleId: {
            type: "string",
            description: "The ID of the schedule to delete"
          }
        },
        required: ["scheduleId"]
      }
    }
  }
];

/**
 * Load schedules from JSON file
 */
function loadSchedules() {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) {
      return { schedules: [] };
    }
    const data = fs.readFileSync(SCHEDULES_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("[scheduler] Error loading schedules:", err.message);
    return { schedules: [] };
  }
}

/**
 * Save schedules to JSON file
 */
function saveSchedules(data) {
  try {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[scheduler] Error saving schedules:", err.message);
  }
}

/**
 * Get schedules for a specific user
 */
function getSchedulesByUser(userId) {
  const data = loadSchedules();
  return data.schedules.filter((s) => s.userId === userId);
}

/**
 * Get a specific schedule by ID
 */
function getScheduleById(scheduleId) {
  const data = loadSchedules();
  return data.schedules.find((s) => s.id === scheduleId);
}

/**
 * Add a new schedule
 */
function addSchedule(scheduleData) {
  const data = loadSchedules();
  data.schedules.push(scheduleData);
  saveSchedules(data);
}

/**
 * Update an existing schedule
 */
function updateSchedule(scheduleId, updates) {
  const data = loadSchedules();
  const index = data.schedules.findIndex((s) => s.id === scheduleId);
  if (index !== -1) {
    data.schedules[index] = { ...data.schedules[index], ...updates };
    saveSchedules(data);
    return data.schedules[index];
  }
  return null;
}

/**
 * Delete a schedule
 */
function deleteSchedule(scheduleId) {
  const data = loadSchedules();
  data.schedules = data.schedules.filter((s) => s.id !== scheduleId);
  saveSchedules(data);

  // Cancel the job if it exists
  cancelJob(scheduleId);
}

/**
 * Cancel a scheduled job
 */
function cancelJob(scheduleId) {
  const job = activeJobs.get(scheduleId);
  if (job) {
    job.cancel();
    activeJobs.delete(scheduleId);
    console.log(`[scheduler] Cancelled job ${scheduleId}`);
  }
}

/**
 * Get recurrence rule for node-schedule
 */
function getRecurrenceRule(scheduleData) {
  const [hour, minute] = scheduleData.time.split(":").map(Number);

  if (scheduleData.recurrence === "once") {
    // For one-time schedules, return a Date object
    const date = new Date(scheduleData.startDate || new Date());
    date.setHours(hour, minute, 0, 0);
    return date;
  }

  const rule = new schedule.RecurrenceRule();
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = scheduleData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  switch (scheduleData.recurrence) {
    case "daily":
      // Runs every day at specified time
      break;
    case "weekdays":
      rule.dayOfWeek = [1, 2, 3, 4, 5]; // Mon-Fri
      break;
    case "weekly":
      if (scheduleData.startDate) {
        rule.dayOfWeek = new Date(scheduleData.startDate).getDay();
      }
      break;
    case "monthly":
      if (scheduleData.startDate) {
        rule.date = new Date(scheduleData.startDate).getDate();
      }
      break;
  }

  return rule;
}

/**
 * Calculate next run time for a schedule
 */
function calculateNextRun(scheduleData) {
  const rule = getRecurrenceRule(scheduleData);

  if (rule instanceof Date) {
    return rule > new Date() ? rule.toISOString() : null;
  }

  // For recurring schedules, use node-schedule to get next invocation
  const tempJob = schedule.scheduleJob(rule, () => {});
  const nextInvocation = tempJob.nextInvocation();
  tempJob.cancel();

  return nextInvocation ? nextInvocation.toISOString() : null;
}

/**
 * Execute a scheduled prompt through the LLM
 */
async function executeScheduledPrompt(scheduleObj, client, lmstudio, systemPrompt, allTools, executeToolsFunction) {
  console.log(`[scheduler] Executing schedule ${scheduleObj.id}: "${scheduleObj.prompt}"`);

  try {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: scheduleObj.prompt }
    ];

    let finalResponse = "No response from model.";
    const MAX_ITERATIONS = 10;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await lmstudio.chat.completions.create({
        model: process.env.LM_STUDIO_MODEL || "openai/gpt-oss-20b",
        messages,
        tools: allTools,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      if (choice.finish_reason !== "tool_calls") {
        finalResponse = choice.message.content || "No response from model.";
        break;
      }

      // Process tool calls
      const toolResults = [];
      for (const call of choice.message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function.arguments);
          console.log(`[scheduler] Tool call: ${call.function.name}`, args);
          result = await executeToolsFunction(call.function.name, args);
        } catch (err) {
          result = `Error: ${err.message}`;
          console.error(`[scheduler] Tool execution error:`, err);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      messages.push(...toolResults);
    }

    // Send result to user via DM
    await client.chat.postMessage({
      channel: scheduleObj.userId,
      text: `🕐 *Scheduled Task:* ${scheduleObj.prompt}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🕐 *Scheduled Task:* ${scheduleObj.prompt}`
          }
        },
        {
          type: "divider"
        },
        ...formatResponse(finalResponse)
      ]
    });

    // Update lastRun
    updateSchedule(scheduleObj.id, {
      lastRun: new Date().toISOString()
    });

    // If one-time, delete after execution
    if (scheduleObj.recurrence === "once") {
      console.log(`[scheduler] One-time schedule ${scheduleObj.id} completed, deleting`);
      deleteSchedule(scheduleObj.id);
    } else {
      // Update nextRun for recurring schedules
      const nextRun = calculateNextRun(scheduleObj);
      updateSchedule(scheduleObj.id, { nextRun });
    }

  } catch (err) {
    console.error(`[scheduler] Error executing schedule ${scheduleObj.id}:`, err);

    // Notify user of error
    try {
      await client.chat.postMessage({
        channel: scheduleObj.userId,
        text: `⚠️ Error executing scheduled task: ${scheduleObj.prompt}\n\nError: ${err.message}`
      });
    } catch (notifyErr) {
      console.error(`[scheduler] Failed to notify user of error:`, notifyErr);
    }
  }
}

/**
 * Format response for Slack (simple version of toSlackMessage)
 */
function formatResponse(text) {
  const mrkdwn = text
    .trim()
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/__(.+?)__/gs, "*$1*")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n");

  // Split into blocks (max 3000 chars each)
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

  return blocks;
}

/**
 * Create a scheduled job
 */
function scheduleJob(scheduleObj, client, lmstudio, systemPrompt, allTools, executeToolsFunction) {
  const rule = getRecurrenceRule(scheduleObj);

  const job = schedule.scheduleJob(rule, () => {
    executeScheduledPrompt(scheduleObj, client, lmstudio, systemPrompt, allTools, executeToolsFunction);
  });

  if (job) {
    activeJobs.set(scheduleObj.id, job);
    console.log(`[scheduler] Scheduled job ${scheduleObj.id} for ${scheduleObj.recurrence} at ${scheduleObj.time}`);
    return true;
  }

  console.error(`[scheduler] Failed to schedule job ${scheduleObj.id}`);
  return false;
}

/**
 * Initialize scheduler - restore jobs from storage
 */
async function initScheduler(client, lmstudio, systemPrompt, allTools, executeToolsFunction) {
  console.log("[scheduler] Initializing scheduler...");

  const data = loadSchedules();
  let scheduledCount = 0;

  for (const scheduleObj of data.schedules) {
    if (scheduleObj.enabled) {
      // Check if one-time schedule is in the past
      if (scheduleObj.recurrence === "once") {
        const nextRun = calculateNextRun(scheduleObj);
        if (!nextRun) {
          console.log(`[scheduler] Skipping past one-time schedule ${scheduleObj.id}`);
          continue;
        }
      }

      const success = scheduleJob(scheduleObj, client, lmstudio, systemPrompt, allTools, executeToolsFunction);
      if (success) {
        scheduledCount++;

        // Update nextRun
        const nextRun = calculateNextRun(scheduleObj);
        updateSchedule(scheduleObj.id, { nextRun });
      }
    }
  }

  console.log(`[scheduler] Restored ${scheduledCount} scheduled job(s)`);
}

/**
 * Handle modal submission for schedule creation/editing
 */
async function handleModalSubmission(body, view, client, lmstudio, systemPrompt, allTools, executeToolsFunction, isEdit = false) {
  const values = view.state.values;

  // Extract form values
  const prompt = values.prompt_block.prompt_input.value;
  const time = values.time_block.time_input.value;
  const recurrence = values.recurrence_block.recurrence_select.selected_option.value;
  const startDate = values.date_block.date_picker.selected_date || null;

  // Validate time format
  const timeRegex = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/;
  if (!timeRegex.test(time)) {
    console.error("[scheduler] Invalid time format:", time);
    return;
  }

  const userId = body.user.id;

  if (isEdit) {
    // Update existing schedule
    const scheduleId = view.private_metadata;
    const scheduleData = {
      prompt,
      time,
      recurrence,
      startDate,
      updatedAt: new Date().toISOString()
    };

    // Cancel old job
    cancelJob(scheduleId);

    // Update schedule
    const updated = updateSchedule(scheduleId, scheduleData);

    if (updated) {
      // Calculate next run
      const nextRun = calculateNextRun(updated);
      updateSchedule(scheduleId, { nextRun });

      // Create new job
      scheduleJob(updated, client, lmstudio, systemPrompt, allTools, executeToolsFunction);

      await client.chat.postMessage({
        channel: userId,
        text: `✅ Schedule updated: "${prompt}" at ${time} (${recurrence})`
      });
    }
  } else {
    // Create new schedule
    const scheduleId = uuidv4();
    const nextRun = calculateNextRun({
      time,
      recurrence,
      startDate,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });

    const scheduleData = {
      id: scheduleId,
      userId,
      prompt,
      time,
      recurrence,
      startDate,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      nextRun
    };

    addSchedule(scheduleData);
    scheduleJob(scheduleData, client, lmstudio, systemPrompt, allTools, executeToolsFunction);

    await client.chat.postMessage({
      channel: userId,
      text: `✅ Schedule created: "${prompt}" at ${time} (${recurrence})`
    });
  }
}

/**
 * Execute scheduler tools
 */
function executeSchedulerTool(name, args, userId) {
  switch (name) {
    case "open_schedule_modal":
      // Return a message with a button (workaround for trigger_id)
      return {
        trigger_modal: "schedule",
        message: "Click the button below to configure your schedule:"
      };

    case "open_manage_schedules":
      return {
        trigger_modal: "manage",
        message: "Click the button below to manage your schedules:"
      };

    case "list_schedules": {
      const schedules = getSchedulesByUser(userId);
      if (schedules.length === 0) {
        return "You don't have any scheduled tasks.";
      }

      let result = "Your scheduled tasks:\n\n";
      schedules.forEach((s, i) => {
        const status = s.enabled ? "✅" : "⏸️";
        const nextRun = s.nextRun ? new Date(s.nextRun).toLocaleString() : "Not scheduled";
        result += `${i + 1}. ${status} "${s.prompt}"\n`;
        result += `   Time: ${s.time} (${s.recurrence})\n`;
        result += `   Next run: ${nextRun}\n\n`;
      });

      return result;
    }

    case "delete_schedule": {
      const schedule = getScheduleById(args.scheduleId);
      if (!schedule) {
        return "Schedule not found.";
      }

      if (schedule.userId !== userId) {
        return "You can only delete your own schedules.";
      }

      deleteSchedule(args.scheduleId);
      return `Schedule deleted: "${schedule.prompt}"`;
    }

    default:
      throw new Error(`Unknown scheduler tool: ${name}`);
  }
}

module.exports = {
  SCHEDULE_TOOLS,
  executeSchedulerTool,
  initScheduler,
  handleModalSubmission,
  getSchedulesByUser,
  getScheduleById,
  deleteSchedule,
  scheduleJob,
  cancelJob
};
