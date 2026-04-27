const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/obsidian";

// Read a note from Obsidian vault
function readNote(relativePath) {
  const result = execSync(
    `"${OBSIDIAN_BIN}" read path="${relativePath.replace(/"/g, '\\"')}" 2>/dev/null`,
    {
      encoding: "utf8",
      timeout: 30000,
      shell: "/bin/bash",
      maxBuffer: 10 * 1024 * 1024,
    }
  ).trim();
  return result;
}

// Generate audio file from text using Apple's say command
function generateAudio(text, outputPath) {
  // Use Ava (Premium) voice, output as AIFF (native format for say)
  const escapedText = text.replace(/"/g, '\\"').replace(/`/g, "\\`");

  execSync(
    `say -v "Ava (Premium)" -o "${outputPath}" "${escapedText}"`,
    {
      encoding: "utf8",
      timeout: 300000, // 5 minutes max for long texts
      shell: "/bin/bash",
    }
  );
}

// Convert AIFF to MP3 for smaller file size (uses ffmpeg if available)
function convertToMp3(aiffPath, mp3Path) {
  try {
    execSync(`ffmpeg -i "${aiffPath}" -acodec libmp3lame -q:a 2 "${mp3Path}" -y 2>/dev/null`, {
      encoding: "utf8",
      timeout: 120000,
      shell: "/bin/bash",
    });
    return true;
  } catch {
    // ffmpeg not available, use AIFF
    return false;
  }
}

// Main tool implementation
async function readNoteAloud({ path: notePath }, client, channel) {
  if (!notePath) throw new Error("Note path is required");

  // Read the note content
  const content = readNote(notePath);
  if (!content) {
    throw new Error(`Note is empty or could not be read: ${notePath}`);
  }

  // Strip markdown formatting for cleaner speech
  const cleanText = content
    // Remove frontmatter
    .replace(/^---[\s\S]*?---\n*/m, "")
    // Remove markdown headers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic markers
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove wiki-links
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    // Remove HTML tags
    .replace(/<[^>]+>/g, "")
    // Clean up extra whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleanText) {
    throw new Error("Note has no readable text content");
  }

  // Create temp files
  const tempDir = os.tmpdir();
  const baseName = `obsidian-audio-${Date.now()}`;
  const aiffPath = path.join(tempDir, `${baseName}.aiff`);
  const mp3Path = path.join(tempDir, `${baseName}.mp3`);

  try {
    // Generate audio
    generateAudio(cleanText, aiffPath);

    // Try to convert to MP3 for smaller file size
    let audioPath = aiffPath;
    let filename = `${path.basename(notePath, ".md")}.aiff`;

    if (convertToMp3(aiffPath, mp3Path)) {
      audioPath = mp3Path;
      filename = `${path.basename(notePath, ".md")}.mp3`;
      // Clean up AIFF
      fs.unlinkSync(aiffPath);
    }

    // Upload to Slack
    const audioBuffer = fs.readFileSync(audioPath);

    await client.files.uploadV2({
      channel_id: channel,
      file: audioBuffer,
      filename,
      title: `Reading: ${path.basename(notePath, ".md")}`,
      initial_comment: `Here's the audio reading of *${notePath}*`,
    });

    // Clean up temp file
    fs.unlinkSync(audioPath);

    return `Audio generated and uploaded for: ${notePath}`;
  } catch (err) {
    // Clean up any temp files on error
    try { fs.unlinkSync(aiffPath); } catch {}
    try { fs.unlinkSync(mp3Path); } catch {}
    throw err;
  }
}

// Tool definition
const TEXT_TO_SPEECH_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_note_aloud",
      description:
        "Read an Obsidian note aloud and send the audio as a file attachment. " +
        "Uses Apple's Ava (Premium) voice to generate speech from the note content. " +
        "Use this when the user asks you to read something to them or wants an audio version of a note.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative path to the note from the vault root, e.g. 'Projects/MyProject.md' or 'Resources/People/John.md'",
          },
        },
        required: ["path"],
      },
    },
  },
];

async function executeTextToSpeechTool(name, args, client, channel) {
  switch (name) {
    case "read_note_aloud":
      return await readNoteAloud(args, client, channel);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TEXT_TO_SPEECH_TOOLS, executeTextToSpeechTool };
