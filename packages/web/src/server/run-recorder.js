import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function createRunRecorder(runDir) {
  const logsDir = join(runDir, "logs");
  await mkdir(logsDir, { recursive: true });

  let pending = Promise.resolve();
  let writeFailure = null;

  function append(filename, record) {
    const line = `${JSON.stringify({ ...record, timestamp: new Date().toISOString() })}\n`;
    const operation = pending.then(async () => {
      if (writeFailure) throw writeFailure;
      await appendFile(join(logsDir, filename), line, "utf8");
    });
    pending = operation.catch((error) => {
      writeFailure ??= error;
    });
    return operation;
  }

  return {
    event(record) {
      return append("events.jsonl", record);
    },
    conversation(record) {
      return append("conversation.jsonl", record);
    },
    async flush() {
      await pending;
      if (writeFailure) throw writeFailure;
    },
  };
}
