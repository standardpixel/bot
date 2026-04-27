const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

// Query macOS Calendar via osascript. Returns events in the next `days` days.
// Note: Terminal (or whichever process runs node) must have Calendar access
// granted in System Settings → Privacy & Security → Calendars.
// This function is async to avoid blocking the event loop (which would cause
// Slack WebSocket disconnects during slow Calendar queries).
async function getCalendarEvents({ days = 7 } = {}) {
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
      timeout: 30000, // 30 second timeout for slow Calendar app
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
      throw new Error("Calendar request timed out after 30 seconds. The Calendar app may be unresponsive.");
    }
    throw new Error(`Failed to access Calendar: ${err.message}. Make sure Terminal has Calendar access in System Settings.`);
  }
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
      timeout: 10000,
      shell: "/bin/bash",
    });

    const raw = stdout.trim();
    if (!raw) return [];

    return raw.split("~|~").filter(Boolean).map((name) => name.trim());
  } catch (err) {
    console.error("[Calendar Error]", err.message);
    throw new Error(`Failed to get calendar names: ${err.message}`);
  }
}

// Check for conflicting events in a time range
async function checkCalendarConflicts({ startDate, durationMinutes = 60 }) {
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
      timeout: 60000,
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
}

// Create a new calendar event
async function createCalendarEvent({ title, startDate, durationMinutes = 60, calendarName, notes = "" }) {
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
      timeout: 15000,
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
];

async function executeCalendarTool(name, args) {
  switch (name) {
    case "get_calendar_events": return await getCalendarEvents(args);
    case "get_calendar_names": return await getCalendarNames();
    case "check_calendar_conflicts": return await checkCalendarConflicts(args);
    case "create_calendar_event": return await createCalendarEvent(args);
    default: throw new Error(`Unknown calendar tool: ${name}`);
  }
}

module.exports = { CALENDAR_TOOLS, executeCalendarTool };
