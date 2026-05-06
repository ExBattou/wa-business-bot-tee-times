import fs from "fs";

const CSV_FILE = "./conversations.csv";
const CSV_HEADER = "timestamp,user_phone,received_message,bot_response\n";

function escapeCsv(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value).replace(/"/g, '""').replace(/\r?\n/g, " ");
  return `"${str}"`;
}

function ensureCsvFile() {
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, CSV_HEADER, "utf-8");
  }
}

export function logConversation({ userPhone, receivedMessage, botResponse, timestamp = new Date().toISOString() }) {
  try {
    ensureCsvFile();
    const row = [
      escapeCsv(timestamp),
      escapeCsv(userPhone),
      escapeCsv(receivedMessage),
      escapeCsv(botResponse),
    ].join(",") + "\n";
    fs.appendFileSync(CSV_FILE, row, "utf-8");
  } catch (error) {
    console.error("❌ Error guardando conversación en CSV:", error.message);
  }
}
