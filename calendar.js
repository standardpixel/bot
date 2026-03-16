const { execSync } = require("child_process");

// Query macOS Calendar via osascript. Returns events in the next `days` days.
// Note: Terminal (or whichever process runs node) must have Calendar access
// granted in System Settings → Privacy & Security → Calendars.
function getCalendarEvents({ days = 7 } = {}) {
  const script = `
tell application "Calendar"
  set theOutput to ""
  set startDate to current date
  set endDate to startDate + (${Math.floor(days)} * days)
  repeat with aCal in calendars
    try
      set calEvents to every event of aCal whose start date >= startDate and start date <= endDate
      repeat with ev in calEvents
        set evTitle to summary of ev
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
    const raw = execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 30000, // Increase timeout to 30 seconds for slow Calendar app
      shell: "/bin/bash",
    })
      .toString()
      .trim();

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
];

function executeCalendarTool(name, args) {
  switch (name) {
    case "get_calendar_events": return getCalendarEvents(args);
    default: throw new Error(`Unknown calendar tool: ${name}`);
  }
}

module.exports = { CALENDAR_TOOLS, executeCalendarTool };
