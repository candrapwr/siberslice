import { publicConfig } from "../config/env.js";
import { readJsonBody, sendJson, sendError } from "./http.js";
import { sessionIdPattern } from "./session-store.js";
import { handleCreateSession, handleGetSession } from "./routes/sessions.js";
import { handleGenerate } from "./routes/generate.js";
import { handleGallery } from "./routes/gallery.js";
import {
  handleAdminAuthStatus,
  handleAdminLogin,
  handleAdminLogout,
  handleAdminPythonCheck,
  handleAdminRunLogs,
  handleAdminServerErrors,
  handleAdminSessionDetail,
  handleAdminSessionList,
  handleAdminOverview,
  handleAdminSystem,
  handleDeleteAdminSession,
  handleSessionRestore,
  isAdminAuthenticated,
} from "./routes/admin.js";
import { handleExport, handleSessionFile, serveStatic } from "./routes/files.js";

export async function routeRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/config") return sendJson(res, 200, publicConfig());
  if (req.method === "GET" && pathname === "/api/gallery") return handleGallery(res, url);
  if (req.method === "POST" && pathname === "/api/sessions") return handleCreateSession(res);

  if (req.method === "GET" && pathname === "/api/admin/auth") return handleAdminAuthStatus(req, res);
  if (req.method === "POST" && pathname === "/api/admin/login") return handleAdminLogin(req, res);
  if (req.method === "POST" && pathname === "/api/admin/logout") return handleAdminLogout(req, res);
  if ((pathname === "/api/admin" || pathname.startsWith("/api/admin/")) && !isAdminAuthenticated(req)) {
    return sendError(res, 401, "Login admin diperlukan.");
  }

  if (req.method === "GET" && pathname === "/api/admin/sessions") return handleAdminSessionList(res);
  if (req.method === "GET" && pathname === "/api/admin/overview") return handleAdminOverview(res);
  if (req.method === "GET" && pathname === "/api/admin/system") return handleAdminSystem(res);
  if (req.method === "GET" && pathname === "/api/admin/python-check") return handleAdminPythonCheck(res);
  if (req.method === "GET" && pathname === "/api/admin/server-errors") return handleAdminServerErrors(res, url);

  const adminLogsMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/runs\/([^/]+)\/logs\/(conversation|events)$/);
  if (req.method === "GET" && adminLogsMatch) {
    if (!sessionIdPattern.test(adminLogsMatch[1])) return sendError(res, 400, "Session ID tidak valid.");
    return handleAdminRunLogs(res, adminLogsMatch[1], adminLogsMatch[2], adminLogsMatch[3]);
  }

  const adminRestoreMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/restore$/);
  if (adminRestoreMatch) {
    if (!sessionIdPattern.test(adminRestoreMatch[1])) return sendError(res, 400, "Session ID tidak valid.");
    if (req.method === "POST") {
      const body = await readJsonBody(req).catch(() => ({}));
      return handleSessionRestore(res, adminRestoreMatch[1], body);
    }
  }

  const adminSessionMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)$/);
  if (adminSessionMatch) {
    if (!sessionIdPattern.test(adminSessionMatch[1])) return sendError(res, 400, "Session ID tidak valid.");
    if (req.method === "GET") return handleAdminSessionDetail(res, adminSessionMatch[1]);
    if (req.method === "DELETE") return handleDeleteAdminSession(res, adminSessionMatch[1]);
  }

  const exportMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/export$/);
  if (req.method === "GET" && exportMatch) {
    if (!sessionIdPattern.test(exportMatch[1])) return sendError(res, 400, "Session ID tidak valid.");
    return handleExport(res, exportMatch[1], exportMatch[2]);
  }

  const filesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/files\/(.+)$/);
  if (req.method === "GET" && filesMatch) {
    if (!sessionIdPattern.test(filesMatch[1])) return sendError(res, 400, "Session ID tidak valid.");
    return handleSessionFile(res, filesMatch[1], filesMatch[2], url.searchParams.get("download") === "1");
  }

  const generateMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/generate$/);
  if (req.method === "POST" && generateMatch) return handleGenerate(req, res, generateMatch[1]);

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionMatch) {
    if (!sessionIdPattern.test(sessionMatch[1])) return sendError(res, 400, "Session ID tidak valid.");
    return handleGetSession(res, sessionMatch[1]);
  }

  if (pathname.startsWith("/api/")) return sendError(res, 404, "Route API tidak ditemukan.");
  if (req.method === "GET") return serveStatic(res, pathname);
  return sendError(res, 404, "Route tidak ditemukan.");
}
