import { sendJson, sendError } from "../http.js";
import { createSession, readSession } from "../session-store.js";

export async function handleCreateSession(res) {
  const { value } = await createSession();
  return sendJson(res, 201, { id: value.id, createdAt: value.createdAt });
}

export async function handleGetSession(res, id) {
  const session = await readSession(id);
  if (!session) return sendError(res, 404, "Session tidak ditemukan.");
  return sendJson(res, 200, session.value);
}
