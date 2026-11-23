import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { askStream, ingestFile, ingestUrl, listDocuments, deleteDocument, getStore } from "./rag.js";
import * as db from "./db.js";
import { webSearchStatus } from "./websearch.js";
import { detectFileRequest, renderFile } from "./files.js";

const ALLOWED = new Set([".pdf", ".docx", ".csv", ".txt", ".md"]);
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: "/tmp/uploads", limits: { fileSize: 25 * 1024 * 1024 } });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});

app.get("/api/health", (_, res) => res.json({ ok: true }));
app.get("/api/config", (_, res) => res.json({ webSearch: webSearchStatus() }));

// ---------- documents ----------
app.get("/api/documents", wrap(async (_, res) => res.json(await listDocuments())));

app.post("/api/documents", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED.has(ext)) {
      return res.status(400).json({ error: `Unsupported file type "${ext || "none"}". Use PDF, DOCX, CSV, TXT or MD.` });
    }
    res.json(await ingestFile({ path: req.file.path, filename: req.file.originalname }));
  } finally {
    unlink(req.file.path).catch(() => {});
  }
}));

app.post("/api/documents/url", wrap(async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL is required" });
  res.json(await ingestUrl(url));
}));

app.delete("/api/documents/:id", wrap(async (req, res) => {
  await deleteDocument(req.params.id);
  res.json({ ok: true });
}));

// ---------- conversations ----------
app.get("/api/conversations", wrap(async (_, res) => res.json(await db.listConversations())));

app.get("/api/conversations/:id", wrap(async (req, res) => {
  const c = isUuid(req.params.id) ? await db.getConversation(req.params.id) : null;
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  res.json(c);
}));

app.patch("/api/conversations/:id", wrap(async (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: "Title is required" });
  const ok = isUuid(req.params.id) && (await db.renameConversation(req.params.id, title));
  if (!ok) return res.status(404).json({ error: "Conversation not found" });
  res.json({ ok: true });
}));

app.delete("/api/conversations/:id", wrap(async (req, res) => {
  if (isUuid(req.params.id)) await db.deleteConversation(req.params.id);
  res.json({ ok: true });
}));

// ---------- generated files ----------
app.get("/api/files/:id", wrap(async (req, res) => {
  const f = isUuid(req.params.id) ? await db.getFile(req.params.id) : null;
  if (!f) return res.status(404).json({ error: "File not found" });
  res.set({
    "Content-Type": f.mime,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
  res.send(f.data);
}));

// ---------- chat (streamed) ----------
const titleFrom = (q) => (q.length > 60 ? `${q.slice(0, 57)}…` : q);

app.post("/api/chat", async (req, res) => {
  const { question, conversationId, docIds = [], web = false, useDocs = true } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "Question is required" });
  if (conversationId && !isUuid(conversationId)) return res.status(400).json({ error: "Invalid conversation" });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    let convId = conversationId;
    if (convId) {
      if (!(await db.getConversation(convId))) throw Object.assign(new Error("Conversation not found"), { status: 404 });
    } else {
      const c = await db.createConversation(titleFrom(question.trim()));
      convId = c.id;
      send("conversation", c);
    }

    const history = await db.recentMessages(convId, 6);
    await db.addMessage(convId, "user", question.trim());

    let answer = "";
    let sources = [];
    const files = [];
    const format = detectFileRequest(question);
    const opts = { web: Boolean(web), useDocs: Boolean(useDocs), format };
    for await (const ev of askStream(question.trim(), history, docIds, opts)) {
      if (ev.type === "token") answer += ev.data;
      if (ev.type === "sources") sources = ev.data;
      if (ev.type === "document") {
        try {
          const f = await renderFile(ev.data.format, ev.data.markdown);
          const id = await db.saveFile(f.name, f.mime, f.buffer);
          const info = { id, name: f.name, mime: f.mime, size: f.buffer.length };
          files.push(info);
          send("file", info);
        } catch (e) {
          console.error(e);
          send("notice", { message: `Couldn't create the file: ${e.message}` });
        }
        continue; // internal event, not sent to the browser
      }
      send(ev.type, ev.data);
    }
    await db.addMessage(convId, "assistant", answer, sources, files);
  } catch (e) {
    console.error(e);
    send("error", { message: e.message });
  }
  res.end();
});

const port = process.env.PORT || 4000;
Promise.all([getStore(), db.initChatTables()]).then(() =>
  app.listen(port, () => console.log(`API on :${port}`))
);
