import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { askStream, ingestFile, ingestUrl, listDocuments, deleteDocument, getStore } from "./rag.js";
import * as db from "./db.js";
import { webSearchStatus } from "./websearch.js";
import { detectFileRequest, renderFile } from "./files.js";
import { listModels } from "./models.js";
import { parseFiles, mergeFiles, checkFiles, toZip, slug, STACKS } from "./projects.js";

const ALLOWED = new Set([".pdf", ".docx", ".csv", ".txt", ".md"]);
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
const upload = multer({ dest: "/tmp/uploads", limits: { fileSize: 25 * 1024 * 1024 } });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});

app.get("/api/health", (_, res) => res.json({ ok: true }));
app.get("/api/config", (_, res) => res.json({ webSearch: webSearchStatus() }));
app.get("/api/models", wrap(async (_, res) => res.json(await listModels())));
app.get("/api/stacks", (_, res) => res.json(STACKS));

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
app.get("/api/conversations", wrap(async (req, res) => res.json(await db.listConversations(String(req.query.q || "")))));

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

app.get("/api/conversations/:id/export", wrap(async (req, res) => {
  const c = isUuid(req.params.id) ? await db.getConversation(req.params.id) : null;
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  const format = ["md", "pdf", "docx"].includes(req.query.format) ? req.query.format : "md";
  const md = `# ${c.title}\n\n` + c.messages.map((m) =>
    `## ${m.role === "user" ? "You" : "Assistant"}\n\n${m.content}` +
    (m.files?.length ? `\n\n_Files: ${m.files.map((f) => f.name).join(", ")}_` : "")
  ).join("\n\n");
  const f = await renderFile(format, md);
  res.set({ "Content-Type": f.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` });
  res.send(f.buffer);
}));

// ---------- build mode: projects ----------
app.get("/api/conversations/:id/project", wrap(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Conversation not found" });
  res.json(await db.getProject(req.params.id));
}));

app.get("/api/conversations/:id/project.zip", wrap(async (req, res) => {
  const c = isUuid(req.params.id) ? await db.getConversation(req.params.id) : null;
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  const { files } = await db.getProject(req.params.id);
  if (!files.length) return res.status(404).json({ error: "This chat has no project yet." });
  const name = slug(c.title);
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip` });
  res.send(await toZip(files, name));
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
  const {
    question, conversationId, docIds = [], web = false, useDocs = true,
    model = null, replaceLast = false, attachments = [], mode = "chat", stack = "Auto",
  } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "Question is required" });
  if (conversationId && !isUuid(conversationId)) return res.status(400).json({ error: "Invalid conversation" });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // If the browser disconnects (Stop button), cancel the model call.
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  let convId = conversationId;
  let answer = "";
  let sources = [];
  const files = [];
  try {
    let spec = null;
    if (model?.provider) {
      spec = (await listModels()).models.find((m) => m.provider === model.provider && m.model === model.model);
      if (!spec) throw Object.assign(new Error("That model isn't available."), { status: 400 });
    }

    if (convId) {
      if (!(await db.getConversation(convId))) throw Object.assign(new Error("Conversation not found"), { status: 404 });
      if (replaceLast) await db.popLastExchange(convId);
    } else {
      const c = await db.createConversation(titleFrom(question.trim()));
      convId = c.id;
      send("conversation", c);
    }

    const atts = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => isUuid(String(a?.docId)))
      .slice(0, 5)
      .map((a) => ({ docId: a.docId, filename: String(a.filename || "file").slice(0, 200) }));

    const history = await db.recentMessages(convId, 10);
    await db.addMessage(convId, "user", question.trim(), null, null, atts);

    const build = mode === "build";
    const format = build ? null : detectFileRequest(question);
    const project = build ? (await db.getProject(convId)).files : [];
    const opts = {
      web: Boolean(web),
      useDocs: atts.length ? true : Boolean(useDocs),
      format,
      model: spec,
      signal: ac.signal,
      build,
      stack: STACKS.includes(stack) ? stack : "Auto",
      project,
    };
    const scope = atts.length ? atts.map((a) => a.docId) : docIds;

    for await (const ev of askStream(question.trim(), history, scope, opts)) {
      if (ev.type === "token") answer += ev.data;
      if (ev.type === "sources") sources = ev.data;
      if (ev.type === "build_text") {
        try {
          const merged = mergeFiles(project, parseFiles(ev.data));
          const notes = [...merged.problems];
          if (merged.incomplete.length) notes.push(`The reply was cut off, so ${merged.incomplete.join(", ")} may be incomplete. Ask me to "continue" or raise OLLAMA_NUM_CTX.`);
          if (!merged.files.length) notes.push("No files were found in that reply. Try again, or use a larger model.");
          const warnings = await checkFiles(merged.files);
          if (merged.files.length) await db.saveProject(convId, merged.files);
          send("project", { conversationId: convId, files: merged.files.map((f) => ({ path: f.path, size: f.content.length })), warnings, notes });
        } catch (e) {
          console.error(e);
          send("notice", { message: `Couldn't save the project: ${e.message}` });
        }
        continue; // internal event
      }
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
    if (ac.signal.aborted) {
      // Stopped by the person: keep what was written so far.
      if (convId && answer.trim()) await db.addMessage(convId, "assistant", answer, sources, files).catch(() => {});
    } else {
      console.error(e);
      send("error", { message: e.message });
    }
  }
  res.end();
});

const port = process.env.PORT || 4000;
Promise.all([getStore(), db.initChatTables()]).then(() =>
  app.listen(port, () => console.log(`API on :${port}`))
);
