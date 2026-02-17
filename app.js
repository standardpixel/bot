require("dotenv").config();
const { App } = require("@slack/bolt");
const OpenAI = require("openai");
const { TOOLS, executeTool } = require("./obsidian");
const { CALENDAR_TOOLS, executeCalendarTool } = require("./calendar");

const ALL_TOOLS = [...TOOLS, ...CALENDAR_TOOLS];

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const lmstudio = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1",
  apiKey: "lm-studio",
});

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful, knowledgeable assistant. " +
  "You have access to an Obsidian vault and macOS Calendar via tools. " +
  "When the user asks about a person, place, project, topic, or concept — always search the vault first using search_notes before responding. " +
  "If results are found, read the most relevant notes and summarize what you find. " +
  "Only say you don't have information after you have searched and found nothing. " +
  "You can also create and update notes when asked. " +
  "When referencing a note, mention its file path.\n\n" +
  "FORMATTING: You are responding inside Slack. Use Slack mrkdwn formatting only:\n" +
  "- *bold* for bold text (single asterisks)\n" +
  "- _italic_ for italic text\n" +
  "- Section headers as a bold line on its own: *Header*\n" +
  "- Bullet points with a dash: - item\n" +
  "- `inline code` and ```code blocks``` as normal\n" +
  "- Never use ## or ### markdown headers\n" +
  "- Never use ** for bold\n" +
  "- Never use HTML tags\n\n" +
  "MEETING PREP: When the user asks to prepare for a meeting with someone, follow these steps:\n" +
  "1. Call get_calendar_events to find the meeting details and other attendees.\n" +
  "2. Search the vault for notes about the person (try 'folks/' folder).\n" +
  "3. Read any matching notes in full.\n" +
  "4. Look for their company in the notes and search the vault for it (try 'companies/' folder).\n" +
  "5. Search for recent mentions of the person in daily notes or elsewhere.\n" +
  "6. Synthesize everything into a structured briefing with sections: Meeting Details, About [Person], About [Company], Recent Context, and Suggested Topics.";

const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || "20", 10);

// Send an ephemeral status message visible only to the user
async function status(client, channel, user, text) {
  try {
    await client.chat.postEphemeral({ channel, user, text });
  } catch (err) {
    console.error("[status]", err.message);
  }
}

// Human-readable description of what each tool call is doing
function describeToolCall(name, args) {
  switch (name) {
    case "search_notes":    return `Searching vault for "${args.query}"...`;
    case "read_note":       return `Reading note: ${args.path}`;
    case "list_vault":      return `Listing vault${args.folder ? `: ${args.folder}` : ""}...`;
    case "create_note":     return `Creating note: ${args.path}`;
    case "append_to_note":        return `Updating note: ${args.path}`;
    case "get_calendar_events":   return `Checking calendar...`;
    default:                      return `Running ${name}...`;
  }
}

app.message(async ({ message, client, say }) => {
  if (message.channel_type !== "im" || message.subtype || message.bot_id) return;

  const { channel, user } = message;

  try {
    await status(client, channel, user, "Thinking...");

    const history = await client.conversations.history({ channel, limit: HISTORY_LIMIT });

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.messages
        .filter((m) => !m.subtype)
        .reverse()
        .map((m) => ({ role: m.bot_id ? "assistant" : "user", content: m.text || "" })),
    ];

    const MAX_ITERATIONS = 10;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await lmstudio.chat.completions.create({
        model: process.env.LM_STUDIO_MODEL || "openai/gpt-oss-20b",
        messages,
        tools: ALL_TOOLS,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      if (choice.finish_reason !== "tool_calls") {
        await say(choice.message.content || "No response from model.");
        break;
      }

      const toolResults = [];
      for (const call of choice.message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function.arguments);
          await status(client, channel, user, describeToolCall(call.function.name, args));
          console.log(`[tool] ${call.function.name}`, args);
          result = call.function.name.startsWith("get_calendar")
            ? executeCalendarTool(call.function.name, args)
            : executeTool(call.function.name, args);
        } catch (err) {
          result = `Error: ${err.message}`;
        }
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      messages.push(...toolResults);
      await status(client, channel, user, "Thinking...");
    }
  } catch (err) {
    console.error("Error:", err.message);
    await say(`Error: ${err.message}`);
  }
});

(async () => {
  await app.start();
  console.log("sp-bot is running");
})();
