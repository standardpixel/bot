const Anthropic = require("@anthropic-ai/sdk");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Active sessions: maps Slack thread_ts to conversation state
const activeSessions = new Map();

// Define tools that Claude can use on the host computer
const CLAUDE_TOOLS = [
  {
    name: "bash",
    description: "Execute a bash command on the host computer. Use this to run terminal commands, install packages, run scripts, etc. Returns the command output.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute"
        },
        working_directory: {
          type: "string",
          description: "Optional working directory for the command. Defaults to current directory."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "read_file",
    description: "Read the contents of a file on the host computer. Returns the file contents as a string.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to read"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file on the host computer. Creates the file if it doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to write"
        },
        content: {
          type: "string",
          description: "Content to write to the file"
        }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list_directory",
    description: "List files and directories in a given path on the host computer.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory to list. Defaults to current working directory."
        }
      },
      required: []
    }
  }
];

// Execute tools on the host
function executeTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case "bash": {
        const { command, working_directory } = toolInput;
        const options = {
          encoding: "utf8",
          shell: "/bin/bash",
          timeout: 60000, // 60 second timeout
          maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        };

        if (working_directory) {
          options.cwd = working_directory;
        }

        const output = execSync(command, options);
        return output.toString();
      }

      case "read_file": {
        const { path: filePath } = toolInput;
        const content = fs.readFileSync(filePath, "utf8");
        return content;
      }

      case "write_file": {
        const { path: filePath, content } = toolInput;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, "utf8");
        return `Successfully wrote ${content.length} characters to ${filePath}`;
      }

      case "list_directory": {
        const { path: dirPath } = toolInput;
        const targetPath = dirPath || process.cwd();
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        return entries.map(entry => {
          const type = entry.isDirectory() ? "dir" : "file";
          return `${type}: ${entry.name}`;
        }).join("\n");
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error) {
    return `Error executing ${toolName}: ${error.message}`;
  }
}

// Run a Claude Code session for a task
async function runClaudeCodeTask(task, client, channel, threadTs) {
  const sessionId = threadTs || channel;

  // Initialize or get existing conversation
  let messages = [];
  if (activeSessions.has(sessionId)) {
    messages = activeSessions.get(sessionId);
  } else {
    messages = [{ role: "user", content: task }];
    activeSessions.set(sessionId, messages);
  }

  // Post initial status
  const statusMsg = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: ":gear: Claude Code is working on your task..."
  });

  let fullResponse = "";
  const MAX_ITERATIONS = 25; // Prevent infinite loops

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    try {
      // Call Claude with streaming
      const stream = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8192,
        tools: CLAUDE_TOOLS,
        messages: messages,
        stream: true,
      });

      let currentMessage = { role: "assistant", content: [] };
      let textBuffer = "";

      // Process the stream
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            currentMessage.content.push({ type: "text", text: "" });
          } else if (event.content_block.type === "tool_use") {
            currentMessage.content.push({
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              input: {}
            });
          }
        } else if (event.type === "content_block_delta") {
          const blockIndex = event.index;

          if (event.delta.type === "text_delta") {
            currentMessage.content[blockIndex].text += event.delta.text;
            textBuffer += event.delta.text;
            fullResponse += event.delta.text;

            // Update Slack message periodically (every 50 chars or on newline)
            if (textBuffer.length > 50 || textBuffer.includes("\n")) {
              await client.chat.update({
                channel,
                ts: statusMsg.ts,
                text: fullResponse || "Working..."
              });
              textBuffer = "";
            }
          } else if (event.delta.type === "input_json_delta") {
            const toolBlock = currentMessage.content[blockIndex];
            if (!toolBlock.input_json) {
              toolBlock.input_json = "";
            }
            toolBlock.input_json += event.delta.partial_json;
          }
        } else if (event.type === "message_stop") {
          break;
        }
      }

      // Finalize tool inputs from JSON strings
      for (const block of currentMessage.content) {
        if (block.type === "tool_use" && block.input_json) {
          block.input = JSON.parse(block.input_json);
          delete block.input_json;
        }
      }

      messages.push(currentMessage);

      // Check if we have tool calls to execute
      const toolCalls = currentMessage.content.filter(c => c.type === "tool_use");

      if (toolCalls.length === 0) {
        // No tool calls, Claude is done
        await client.chat.update({
          channel,
          ts: statusMsg.ts,
          text: fullResponse || "Task completed."
        });

        activeSessions.delete(sessionId);
        return fullResponse;
      }

      // Execute tool calls
      const toolResults = [];
      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolInput = toolCall.input;

        // Show which tool is being executed
        await client.chat.update({
          channel,
          ts: statusMsg.ts,
          text: `${fullResponse}\n\n:wrench: Executing: \`${toolName}\``
        });

        const result = executeTool(toolName, toolInput);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result
        });

        // Show tool output
        const truncatedResult = result.length > 200 ? result.substring(0, 200) + "..." : result;
        await client.chat.update({
          channel,
          ts: statusMsg.ts,
          text: `${fullResponse}\n\n:wrench: \`${toolName}\` output:\n\`\`\`\n${truncatedResult}\n\`\`\``
        });
      }

      // Add tool results to conversation
      messages.push({
        role: "user",
        content: toolResults
      });

      // Continue loop to get Claude's next response
      fullResponse = ""; // Reset for next iteration's text

    } catch (error) {
      console.error("[Claude Code Error]", error);
      await client.chat.update({
        channel,
        ts: statusMsg.ts,
        text: `Error: ${error.message}`
      });
      activeSessions.delete(sessionId);
      throw error;
    }
  }

  // Max iterations reached
  await client.chat.update({
    channel,
    ts: statusMsg.ts,
    text: `${fullResponse}\n\n⚠️ Maximum iterations reached. Task may be incomplete.`
  });
  activeSessions.delete(sessionId);
  return fullResponse;
}

const CLAUDE_CODE_TOOLS = [
  {
    type: "function",
    function: {
      name: "use_claude_code",
      description: "Delegate a task to a Claude Code agent that can execute commands, read/write files, and perform complex operations on the host computer. Use this for development tasks, debugging, file operations, system administration, or any task requiring code execution. The agent has full access to bash, file system, and can work autonomously.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Clear description of the task for Claude Code to accomplish. Be specific about what needs to be done."
          }
        },
        required: ["task"]
      }
    }
  }
];

async function executeClaudeCodeTool(toolName, args, client, channel, threadTs) {
  if (toolName === "use_claude_code") {
    const { task } = args;
    return await runClaudeCodeTask(task, client, channel, threadTs);
  }

  return "Unknown Claude Code tool";
}

module.exports = {
  CLAUDE_CODE_TOOLS,
  executeClaudeCodeTool
};
