const { exec } = require("child_process");
const { promisify } = require("util");
const { ensureCalendarRunning, restartCalendar } = require("./app-launcher");

const execAsync = promisify(exec);

// Retry wrapper for calendar operations with automatic restart on timeout
async function retryCalendarOperation(operationName, operation, maxRetries = 2) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[calendar] ${operationName}: attempt ${attempt}/${maxRetries}`);
      return await operation();
    } catch (err) {
      lastError = err;
      console.error(`[calendar] ${operationName} failed (attempt ${attempt}/${maxRetries}):`, err.message);

      // If this was a timeout and we have retries left, restart Calendar
      if (err.killed && attempt < maxRetries) {
        console.log(`[calendar] ${operationName} timed out, restarting Calendar app...`);
        try {
          restartCalendar();
          console.log(`[calendar] Calendar restarted, retrying ${operationName}...`);
        } catch (restartErr) {
          console.error(`[calendar] Failed to restart Calendar:`, restartErr.message);
          // Continue to next retry anyway
        }
      } else if (attempt < maxRetries) {
        // For non-timeout errors, just ensure Calendar is running
        console.log(`[calendar] Ensuring Calendar is running before retry...`);
        ensureCalendarRunning();
      }
    }
  }

  // All retries exhausted
  if (lastError.killed) {
    throw new Error(`Calendar request timed out after ${maxRetries} attempts. The Calendar app may be unresponsive or have a very large dataset. Try restarting the Calendar app manually.`);
  }
  throw lastError;
}

// Query macOS Calendar via osascript. Returns events in the next `days` days.
// Note: Terminal (or whichever process runs node) must have Calendar access
// granted in System Settings → Privacy & Security → Calendars.
// This function is async to avoid blocking the event loop (which would cause
// Slack WebSocket disconnects during slow Calendar queries).
async function getCalendarEvents({ days = 7 } = {}) {
  return retryCalendarOperation("getCalendarEvents", async () => {
    // Ensure Calendar app is running and responsive before attempting operations
    ensureCalendarRunning();

    const script = `
tell application "Calendar"
  set theOutput to ""
  set startDate to current date
  set endDate to startDate + (${Math.floor(days)} * days)
  repeat with aCal in calendars
    try
      set calEvents to every event of aCal whose start date >= startDate and start date <= endDate
      repeat with ev in calEvents
        try
          set evTitle to summary of ev
        on error
          set evTitle to "(No title)"
        end try
        set evStart to start date of ev as string
        set evEnd to end date of ev as string
        set evAttendees to ""
        try
          repeat with att in attendees of ev
            set evAttendees to evAttendees & display name of att & ", "
          end repeat
        end try
        set theOutput to theOutput & evTitle & "~|~" & evStart & "~|~" & evEnd & "~|~" & evAttendees & "~||~"
      end repeat
    end try
  end repeat
  return theOutput
end tell
`;

    try {
      const { stdout } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 45000, // Increased to 45 seconds
        shell: "/bin/bash",
      });

      const raw = stdout.trim();

      if (!raw) return "No upcoming events found.";

      return raw
        .split("~||~")
        .filter(Boolean)
        .map((line) => {
          const [title, start, end, attendees] = line.split("~|~");
          return {
            title: title?.trim(),
            start: start?.trim(),
            end: end?.trim(),
            attendees: attendees?.trim()
              ? attendees.split(",").map((a) => a.trim()).filter(Boolean)
              : [],
          };
        });
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      if (err.killed) {
        throw new Error("Calendar request timed out. The Calendar app may be unresponsive.");
      }
      throw new Error(`Failed to access Calendar: ${err.message}. Make sure Terminal has Calendar access in System Settings.`);
    }
  });
}

// Helper to format JS Date/ISO string for AppleScript
// AppleScript expects: "January 15, 2024 at 2:00:00 PM"
function formatForAppleScript(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

// Get list of available calendar names
async function getCalendarNames() {
  return retryCalendarOperation("getCalendarNames", async () => {
    // Ensure Calendar app is running and responsive before attempting operations
    ensureCalendarRunning();

    const script = `
tell application "Calendar"
  set calNames to ""
  repeat with aCal in calendars
    set calNames to calNames & name of aCal & "~|~"
  end repeat
  return calNames
end tell
`;

    try {
      const { stdout } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 15000, // Increased to 15 seconds
        shell: "/bin/bash",
      });

      const raw = stdout.trim();
      if (!raw) return [];

      return raw.split("~|~").filter(Boolean).map((name) => name.trim());
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      throw new Error(`Failed to get calendar names: ${err.message}`);
    }
  });
}

// Check for conflicting events in a time range
async function checkCalendarConflicts({ startDate, durationMinutes = 60 }) {
  return retryCalendarOperation("checkCalendarConflicts", async () => {
    // Ensure Calendar app is running and responsive before attempting operations
    ensureCalendarRunning();

    const start = new Date(startDate);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const script = `
tell application "Calendar"
  set theOutput to ""
  set startCheck to date "${formatForAppleScript(start.toISOString())}"
  set endCheck to date "${formatForAppleScript(end.toISOString())}"

  repeat with aCal in calendars
    try
      -- Skip read-only calendars and system calendars for faster queries
      set calName to name of aCal
      if not (writable of aCal) or calName is "Scheduled Reminders" or calName is "Siri Suggestions" then
      else
        set calEvents to every event of aCal whose start date < endCheck and end date > startCheck
        repeat with ev in calEvents
          try
            set evTitle to summary of ev
          on error
            set evTitle to "(No title)"
          end try
          set evStart to start date of ev as string
          set evEnd to end date of ev as string
          set evCal to name of aCal
          set theOutput to theOutput & evTitle & "~|~" & evStart & "~|~" & evEnd & "~|~" & evCal & "~||~"
        end repeat
      end if
    end try
  end repeat
  return theOutput
end tell
`;

    try {
      const { stdout, stderr } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 60000, // Keep at 60 seconds
        shell: "/bin/bash",
      });

      if (stderr) {
        console.error("[Calendar stderr]", stderr);
      }

      const raw = stdout.trim();
      if (!raw) return { conflicts: [], hasConflicts: false };

      const conflicts = raw
        .split("~||~")
        .filter(Boolean)
        .map((line) => {
          const [title, start, end, calendar] = line.split("~|~");
          return {
            title: title?.trim(),
            start: start?.trim(),
            end: end?.trim(),
            calendar: calendar?.trim(),
          };
        });

      return { conflicts, hasConflicts: conflicts.length > 0 };
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      if (err.stderr) {
        console.error("[Calendar stderr]", err.stderr);
      }
      if (err.killed) {
        throw new Error("Calendar conflict check timed out. The Calendar app may be unresponsive.");
      }
      throw new Error(`Failed to check calendar conflicts: ${err.stderr || err.message}`);
    }
  });
}

// Find a specific event by title and approximate date (helper function)
async function findEvent({ title, date }) {
  return retryCalendarOperation("findEvent", async () => {
    ensureCalendarRunning();

    const searchDate = new Date(date);
    const dayBefore = new Date(searchDate.getTime() - 24 * 60 * 60 * 1000);
    const dayAfter = new Date(searchDate.getTime() + 24 * 60 * 60 * 1000);

    const script = `
tell application "Calendar"
  set theOutput to ""
  set searchStart to date "${formatForAppleScript(dayBefore.toISOString())}"
  set searchEnd to date "${formatForAppleScript(dayAfter.toISOString())}"

  repeat with aCal in calendars
    try
      set calEvents to every event of aCal whose start date >= searchStart and start date <= searchEnd
      repeat with ev in calEvents
        try
          set evTitle to summary of ev
          if evTitle contains "${title.replace(/"/g, '\\"')}" then
            set evStart to start date of ev as string
            set evEnd to end date of ev as string
            set evCal to name of aCal
            set evUID to uid of ev
            set evNotes to ""
            try
              set evNotes to description of ev
            end try
            set theOutput to theOutput & evTitle & "~|~" & evStart & "~|~" & evEnd & "~|~" & evCal & "~|~" & evUID & "~|~" & evNotes & "~||~"
          end if
        end try
      end repeat
    end try
  end repeat
  return theOutput
end tell
`;

    try {
      const { stdout } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 30000,
        shell: "/bin/bash",
      });

      const raw = stdout.trim();
      if (!raw) return [];

      return raw
        .split("~||~")
        .filter(Boolean)
        .map((line) => {
          const [title, start, end, calendar, uid, notes] = line.split("~|~");
          return {
            title: title?.trim(),
            start: start?.trim(),
            end: end?.trim(),
            calendar: calendar?.trim(),
            uid: uid?.trim(),
            notes: notes?.trim() || "",
          };
        });
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      throw new Error(`Failed to find event: ${err.message}`);
    }
  });
}

// Update an existing calendar event
async function updateCalendarEvent({ title, date, newTitle, newStartDate, newDurationMinutes, newNotes, confirm = false }) {
  return retryCalendarOperation("updateCalendarEvent", async () => {
    ensureCalendarRunning();

    // First find the event
    const events = await findEvent({ title, date });

    if (events.length === 0) {
      throw new Error(`No event found matching "${title}" near ${date}`);
    }

    if (events.length > 1) {
      const eventList = events.map(e => `- "${e.title}" on ${e.start} (${e.calendar})`).join("\n");
      throw new Error(`Multiple events found matching "${title}":\n${eventList}\n\nPlease be more specific with the title or date.`);
    }

    const event = events[0];

    // If confirm mode, return preview
    if (confirm) {
      const changes = [];
      if (newTitle && newTitle !== event.title) changes.push(`Title: "${event.title}" → "${newTitle}"`);
      if (newStartDate) changes.push(`Start: ${event.start} → ${new Date(newStartDate).toLocaleString()}`);
      if (newDurationMinutes) changes.push(`Duration: changed to ${newDurationMinutes} minutes`);
      if (newNotes !== undefined) changes.push(`Notes: ${event.notes ? 'updated' : 'added'}`);

      return {
        action: "update_calendar_event",
        event: {
          title: event.title,
          start: event.start,
          calendar: event.calendar
        },
        changes,
        needsConfirmation: true
      };
    }

    // Perform the update
    const escapedUID = event.uid.replace(/"/g, '\\"');
    const updates = [];

    if (newTitle) {
      updates.push(`set summary of targetEvent to "${newTitle.replace(/"/g, '\\"')}"`);
    }
    if (newStartDate) {
      const start = new Date(newStartDate);
      const duration = newDurationMinutes || 60;
      updates.push(`set start date of targetEvent to date "${formatForAppleScript(start.toISOString())}"`);
      updates.push(`set end date of targetEvent to (start date of targetEvent) + (${duration} * minutes)`);
    } else if (newDurationMinutes) {
      updates.push(`set end date of targetEvent to (start date of targetEvent) + (${newDurationMinutes} * minutes)`);
    }
    if (newNotes !== undefined) {
      updates.push(`set description of targetEvent to "${newNotes.replace(/"/g, '\\"')}"`);
    }

    if (updates.length === 0) {
      return { success: true, message: "No changes specified" };
    }

    const script = `
tell application "Calendar"
  repeat with aCal in calendars
    try
      set targetEvent to first event of aCal whose uid is "${escapedUID}"
      ${updates.join("\n      ")}
      return "Updated: " & summary of targetEvent & " on " & (start date of targetEvent as string)
    end try
  end repeat
  error "Event not found"
end tell
`;

    try {
      const { stdout } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 20000,
        shell: "/bin/bash",
      });

      return { success: true, message: stdout.trim() };
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      throw new Error(`Failed to update calendar event: ${err.message}`);
    }
  });
}

// Delete a calendar event
async function deleteCalendarEvent({ title, date, confirm = false }) {
  return retryCalendarOperation("deleteCalendarEvent", async () => {
    ensureCalendarRunning();

    // First find the event
    const events = await findEvent({ title, date });

    if (events.length === 0) {
      throw new Error(`No event found matching "${title}" near ${date}`);
    }

    if (events.length > 1) {
      const eventList = events.map(e => `- "${e.title}" on ${e.start} (${e.calendar})`).join("\n");
      throw new Error(`Multiple events found matching "${title}":\n${eventList}\n\nPlease be more specific with the title or date.`);
    }

    const event = events[0];

    // If confirm mode, return preview
    if (confirm) {
      return {
        action: "delete_calendar_event",
        event: {
          title: event.title,
          start: event.start,
          end: event.end,
          calendar: event.calendar,
          notes: event.notes
        },
        needsConfirmation: true
      };
    }

    // Perform the deletion
    const escapedUID = event.uid.replace(/"/g, '\\"');

    const script = `
tell application "Calendar"
  repeat with aCal in calendars
    try
      set targetEvent to first event of aCal whose uid is "${escapedUID}"
      set eventTitle to summary of targetEvent
      set eventStart to start date of targetEvent as string
      delete targetEvent
      return "Deleted: " & eventTitle & " on " & eventStart
    end try
  end repeat
  error "Event not found"
end tell
`;

    try {
      const { stdout } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 20000,
        shell: "/bin/bash",
      });

      return { success: true, message: stdout.trim() };
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      throw new Error(`Failed to delete calendar event: ${err.message}`);
    }
  });
}

// Create a new calendar event
async function createCalendarEvent({ title, startDate, durationMinutes = 60, calendarName, notes = "" }) {
  return retryCalendarOperation("createCalendarEvent", async () => {
    // Ensure Calendar app is running and responsive before attempting operations
    ensureCalendarRunning();

    const start = new Date(startDate);
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedNotes = notes.replace(/"/g, '\\"');
    const escapedCalendar = calendarName.replace(/"/g, '\\"');

    const notesProperty = notes ? `, description:"${escapedNotes}"` : "";

    const script = `
tell application "Calendar"
  set targetCal to first calendar whose name is "${escapedCalendar}"
  set startTime to date "${formatForAppleScript(start.toISOString())}"
  set endTime to startTime + (${durationMinutes} * minutes)

  tell targetCal
    set newEvent to make new event with properties {summary:"${escapedTitle}", start date:startTime, end date:endTime${notesProperty}}
  end tell

  return "Created: " & summary of newEvent & " from " & (start date of newEvent as string) & " to " & (end date of newEvent as string)
end tell
`;

    try {
      const { stdout } = await execAsync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        timeout: 20000, // Increased to 20 seconds
        shell: "/bin/bash",
      });

      return { success: true, message: stdout.trim() };
    } catch (err) {
      console.error("[Calendar Error]", err.message);
      if (err.message.includes("Can't get calendar")) {
        throw new Error(`Calendar "${calendarName}" not found. Use get_calendar_names to see available calendars.`);
      }
      throw new Error(`Failed to create calendar event: ${err.message}`);
    }
  });
}

const CALENDAR_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_calendar_events",
      description:
        "Get upcoming events from macOS Calendar. Use this for meeting prep to find when a meeting is scheduled and who else is attending.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "How many days ahead to look. Defaults to 7.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_calendar_names",
      description:
        "Get the list of available calendar names (e.g., 'Work', 'Personal'). Use this to help the user choose which calendar to add an event to.",
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
      name: "check_calendar_conflicts",
      description:
        "Check if there are any existing events that conflict with a proposed time slot. Returns overlapping events if any exist. IMPORTANT: Always call this BEFORE creating a calendar event.",
      parameters: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "Start time in ISO 8601 format (e.g., '2024-01-15T14:00:00')",
          },
          durationMinutes: {
            type: "number",
            description: "Duration of the proposed event in minutes. Defaults to 60.",
          },
        },
        required: ["startDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description:
        "Create a new event on a specific macOS calendar. IMPORTANT: Before calling this, always call check_calendar_conflicts first. If conflicts exist, ask the user for clarification before proceeding. If no conflicts, create the event directly.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title/summary of the event",
          },
          startDate: {
            type: "string",
            description: "Start time in ISO 8601 format (e.g., '2024-01-15T14:00:00')",
          },
          durationMinutes: {
            type: "number",
            description: "Duration of the event in minutes. Defaults to 60.",
          },
          calendarName: {
            type: "string",
            description: "Name of the calendar to create the event on (e.g., 'Work', 'Personal')",
          },
          notes: {
            type: "string",
            description: "Optional notes/description for the event",
          },
        },
        required: ["title", "startDate", "calendarName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_calendar_event",
      description:
        "Update an existing calendar event. Finds the event by title and date, then updates specified fields. IMPORTANT: Always confirm with the user before updating calendar events unless they explicitly requested the change.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Current title of the event to find",
          },
          date: {
            type: "string",
            description: "Approximate date of the event in ISO 8601 format (e.g., '2024-01-15'). Used to find the event.",
          },
          newTitle: {
            type: "string",
            description: "New title for the event (optional)",
          },
          newStartDate: {
            type: "string",
            description: "New start time in ISO 8601 format (e.g., '2024-01-15T14:00:00') (optional)",
          },
          newDurationMinutes: {
            type: "number",
            description: "New duration in minutes (optional)",
          },
          newNotes: {
            type: "string",
            description: "New notes/description for the event (optional)",
          },
          confirm: {
            type: "boolean",
            description: "If true, returns a preview of changes without actually updating. Use this to show the user what will change before making destructive changes.",
          },
        },
        required: ["title", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_calendar_event",
      description:
        "Delete a calendar event. Finds the event by title and date, then deletes it. IMPORTANT: ALWAYS confirm with the user before deleting calendar events. This is a destructive action that cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the event to delete",
          },
          date: {
            type: "string",
            description: "Approximate date of the event in ISO 8601 format (e.g., '2024-01-15'). Used to find the event.",
          },
          confirm: {
            type: "boolean",
            description: "If true, returns a preview of the event to be deleted without actually deleting it. ALWAYS set this to true first to show the user what will be deleted.",
          },
        },
        required: ["title", "date"],
      },
    },
  },
];

async function executeCalendarTool(name, args) {
  switch (name) {
    case "get_calendar_events": return await getCalendarEvents(args);
    case "get_calendar_names": return await getCalendarNames();
    case "check_calendar_conflicts": return await checkCalendarConflicts(args);
    case "create_calendar_event": return await createCalendarEvent(args);
    case "update_calendar_event": return await updateCalendarEvent(args);
    case "delete_calendar_event": return await deleteCalendarEvent(args);
    default: throw new Error(`Unknown calendar tool: ${name}`);
  }
}

module.exports = { CALENDAR_TOOLS, executeCalendarTool };
