import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const EXT = { python: "py", javascript: "js", typescript: "ts", jsx: "jsx", tsx: "tsx", html: "html", css: "css",
  json: "json", bash: "sh", sh: "sh", sql: "sql", java: "java", c: "c", cpp: "cpp", go: "go", rust: "rs",
  yaml: "yml", yml: "yml", markdown: "md", csv: "csv", xml: "xml" };

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `code.${EXT[lang?.toLowerCase()] || "txt"}` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="code">
      <div className="codebar">
        <span>{lang || "code"}</span>
        <span>
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <button onClick={download}>Download</button>
        </span>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

const mdComponents = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const lang = /language-([\w+-]+)/.exec(child?.props?.className || "")?.[1];
    const code = String(child?.props?.children ?? "").replace(/\n$/, "");
    return <CodeBlock lang={lang} code={code} />;
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  table: ({ children }) => <div className="tablewrap"><table>{children}</table></div>,
};

const Markdown = ({ text }) => (
  <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown></div>
);

const ALLOWED = [".pdf", ".docx", ".csv", ".txt", ".md"];
const extOf = (n) => n.slice(n.lastIndexOf(".")).toLowerCase();
const dropLast = (m) => {
  const c = [...m];
  if (c.at(-1)?.role === "assistant") c.pop();
  if (c.at(-1)?.role === "user") c.pop();
  return c;
};

const SUGGESTIONS = [
  "Write a Python script that renames all files in a folder by date",
  "Create a Word document with a one-page project proposal template",
  "Make an Excel sheet to track monthly expenses",
  "Make a PowerPoint presentation about the benefits of remote work",
];

export default function App() {
  const [tab, setTab] = useState("chats");
  const [docs, setDocs] = useState([]);
  const [selected, setSelected] = useState([]); // empty = search all
  const [conversations, setConversations] = useState([]);
  const [chatQuery, setChatQuery] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]); // pending attachments
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [config, setConfig] = useState({});
  const [modelList, setModelList] = useState({ default: null, models: [] });
  const [modelKey, setModelKey] = useState(() => {
    try { return localStorage.getItem("model") || ""; } catch { return ""; }
  });
  const [useDocs, setUseDocs] = useState(() => {
    try { return localStorage.getItem("useDocs") === "1"; } catch { return false; }
  });
  const [web, setWeb] = useState(() => {
    try { return localStorage.getItem("webSearch") === "1"; } catch { return false; }
  });
  const fileRef = useRef();
  const attachRef = useRef();
  const endRef = useRef();
  const inputRef = useRef();
  const abortRef = useRef(null);

  const loadDocs = () =>
    api("/api/documents")
      .then((d) => {
        setDocs(d);
        setSelected((sel) => sel.filter((id) => d.some((x) => x.docId === id)));
      })
      .catch((e) => setError(e.message));
  const loadConversations = (q = chatQuery) =>
    api(`/api/conversations?q=${encodeURIComponent(q)}`).then(setConversations).catch((e) => setError(e.message));

  useEffect(() => {
    loadDocs();
    api("/api/config").then(setConfig).catch(() => {});
    api("/api/models").then(setModelList).catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => loadConversations(chatQuery), 250);
    return () => clearTimeout(t);
  }, [chatQuery]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Grow the input box with its content (up to a cap, then scroll); shrink back when cleared.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
  const webOn = Boolean(config.webSearch?.enabled) && web;
  const toggleDocs = (v) => { setUseDocs(v); store("useDocs", v ? "1" : "0"); };
  const toggleWeb = (v) => { setWeb(v); store("webSearch", v ? "1" : "0"); };
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const keyOf = (m) => `${m.provider}|${m.model}`;
  const chosen = modelList.models.find((m) => keyOf(m) === modelKey) || null; // null = server default
  const selectValue = chosen ? keyOf(chosen) : modelList.default ? keyOf(modelList.default) : "";
  const pickModel = (k) => {
    const isDefault = modelList.default && k === keyOf(modelList.default);
    setModelKey(isDefault ? "" : k);
    store("model", isDefault ? "" : k);
  };

  // ----- documents -----
  async function addFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setAdding(true); setError("");
    const body = new FormData();
    body.append("file", file);
    try { await api("/api/documents", { method: "POST", body }); await loadDocs(); toggleDocs(true); }
    catch (err) { setError(err.message); }
    finally { setAdding(false); e.target.value = ""; }
  }

  async function addUrl(e) {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url) return;
    setAdding(true); setError("");
    try { await api("/api/documents/url", json("POST", { url })); setUrlInput(""); await loadDocs(); toggleDocs(true); }
    catch (err) { setError(err.message); }
    finally { setAdding(false); }
  }

  async function removeDoc(id) {
    try { await api(`/api/documents/${id}`, { method: "DELETE" }); loadDocs(); }
    catch (err) { setError(err.message); }
  }

  // ----- attachments (drag, paste or click) -----
  function addFiles(list) {
    const ok = [], bad = [];
    for (const f of list) (ALLOWED.includes(extOf(f.name)) ? ok : bad).push(f);
    if (bad.length) setError(`Unsupported file: ${bad.map((f) => f.name).join(", ")}. Use PDF, DOCX, CSV, TXT or MD.`);
    if (ok.length) setFiles((prev) => [...prev, ...ok].slice(0, 5));
  }

  // ----- conversations -----
  function newChat() {
    if (busy) return;
    setActiveId(null); setMessages([]); setError(""); setEditing(false); setInput("");
  }

  async function openChat(id) {
    if (busy || id === activeId) return;
    try {
      const c = await api(`/api/conversations/${id}`);
      setActiveId(id); setMessages(c.messages); setError(""); setEditing(false);
    } catch (err) { setError(err.message); loadConversations(); }
  }

  async function renameChat(c) {
    const title = window.prompt("Rename chat", c.title)?.trim();
    if (!title) return;
    try { await api(`/api/conversations/${c.id}`, json("PATCH", { title })); loadConversations(); }
    catch (err) { setError(err.message); }
  }

  async function removeChat(c) {
    if (!window.confirm(`Delete "${c.title}"?`)) return;
    try {
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (c.id === activeId) { setActiveId(null); setMessages([]); }
      loadConversations();
    } catch (err) { setError(err.message); }
  }

  // ----- chat -----
  const patchLast = (fn) =>
    setMessages((m) => { const c = [...m]; c[c.length - 1] = fn(c[c.length - 1]); return c; });

  function handleEvent(raw) {
    let event = "message", data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === "conversation") { setActiveId(payload.id); loadConversations(); }
    else if (event === "notice") patchLast((m) => ({ ...m, notice: payload.message }));
    else if (event === "file") patchLast((m) => ({ ...m, files: [...(m.files || []), payload] }));
    else if (event === "sources") patchLast((m) => ({ ...m, sources: payload }));
    else if (event === "token") patchLast((m) => ({ ...m, content: m.content + payload }));
    else if (event === "error") setError(payload.message);
  }

  async function submit(text, { replaceLast = false, keepAttachments = [] } = {}) {
    const question = text.trim();
    if (!question || busy) return;
    setError(""); setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let added = false;
    try {
      // 1) index any attached files, then scope this question to them
      const attached = [...keepAttachments];
      for (const f of files) {
        setStatus(`Indexing ${f.name}… (large files take a while on a local model)`);
        const body = new FormData();
        body.append("file", f);
        const d = await api("/api/documents", { method: "POST", body, signal: ac.signal });
        attached.push({ docId: d.docId, filename: d.filename });
      }
      if (files.length) { setFiles([]); loadDocs(); }
      setStatus("");

      // 2) ask
      setMessages((m) => [
        ...(replaceLast ? dropLast(m) : m),
        { role: "user", content: question, attachments: attached },
        { role: "assistant", content: "", sources: [], files: [] },
      ]);
      added = true;
      setInput(""); setEditing(false);

      const res = await fetch("/api/chat", {
        ...json("POST", {
          question, conversationId: activeId, docIds: selected, web: webOn, useDocs,
          model: chosen ? { provider: chosen.provider, model: chosen.model } : null,
          replaceLast: replaceLast && Boolean(activeId),
          attachments: attached,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        parts.forEach(handleEvent);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setError(err.message);
        if (added) setMessages((m) => (m.at(-1)?.role === "assistant" && m.at(-1).content === "" ? m.slice(0, -2) : m));
      }
    } finally {
      setBusy(false); setStatus(""); abortRef.current = null;
      loadConversations();
    }
  }

  const stop = () => abortRef.current?.abort();
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastAsstIdx = messages.map((m) => m.role).lastIndexOf("assistant");

  function regenerate() {
    const u = messages[lastUserIdx];
    if (u) submit(u.content, { replaceLast: true, keepAttachments: u.attachments || [] });
  }
  function editLast() {
    const u = messages[lastUserIdx];
    if (!u) return;
    setInput(u.content); setEditing(true);
    inputRef.current?.focus();
  }
  const onSubmit = (e) => { e.preventDefault(); submit(input, { replaceLast: editing }); };

  const docScope = selected.length === 0
    ? "all your documents"
    : `${selected.length} selected ${selected.length === 1 ? "document" : "documents"}`;
  const scope = [useDocs ? `Using ${docScope}` : "General chat", webOn ? "web search on" : null].filter(Boolean).join(" · ");

  return (
    <div className="app">
      <aside className="library">
        <h1>Ask your documents</h1>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "chats"} className={tab === "chats" ? "on" : ""} onClick={() => setTab("chats")}>Chats</button>
          <button role="tab" aria-selected={tab === "docs"} className={tab === "docs" ? "on" : ""} onClick={() => setTab("docs")}>Documents ({docs.length})</button>
        </div>

        {tab === "chats" && (
          <>
            <button className="primary" onClick={newChat} disabled={busy}>New chat</button>
            <input className="search" value={chatQuery} onChange={(e) => setChatQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
            <ul className="list">
              {conversations.length === 0 && <li className="empty">{chatQuery ? "No chats match your search." : "No saved chats yet. Ask a question to start one."}</li>}
              {conversations.map((c) => (
                <li key={c.id} className={c.id === activeId ? "active" : ""}>
                  <button className="row" onClick={() => openChat(c.id)} title={c.title}>{c.title}</button>
                  <button className="ghost" aria-label={`Rename ${c.title}`} onClick={() => renameChat(c)}>Rename</button>
                  <button className="ghost danger" aria-label={`Delete ${c.title}`} onClick={() => removeChat(c)}>Delete</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === "docs" && (
          <>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.csv,.txt,.md" hidden onChange={addFile} />
            <button className="primary" onClick={() => fileRef.current.click()} disabled={adding}>
              {adding ? "Indexing…" : "Add a file"}
            </button>
            <p className="hint small">PDF, Word (.docx), CSV, text or Markdown.</p>
            <form className="urlform" onSubmit={addUrl}>
              <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="Or paste a web page URL" aria-label="Web page URL" />
              <button className="primary" disabled={adding || !urlInput.trim()}>Add</button>
            </form>
            <ul className="list">
              {docs.length === 0 && <li className="empty">No documents yet.</li>}
              {docs.map((d) => (
                <li key={d.docId}>
                  <label>
                    <input type="checkbox" checked={selected.includes(d.docId)} onChange={() => toggle(d.docId)} />
                    <div><strong title={d.filename}>{d.filename}</strong><span>{d.url ? "web page · " : ""}{d.chunks} passages</span></div>
                  </label>
                  <button className="ghost danger" aria-label={`Remove ${d.filename}`} onClick={() => removeDoc(d.docId)}>Remove</button>
                </li>
              ))}
            </ul>
            {docs.length > 0 && (
              <p className="hint small">
                Tick documents to limit your search to them. {selected.length > 0 && <button className="link" onClick={() => setSelected([])}>Clear selection</button>}
              </p>
            )}
          </>
        )}
      </aside>

      <main
        className="chat"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      >
        {dragging && <div className="dropzone">Drop files to attach (PDF, Word, CSV, text)</div>}
        <header className="bar">
          <span>{scope}</span>
          <div className="barright">
            {modelList.models.length > 0 && (
              <select className="modelpick" value={selectValue} onChange={(e) => pickModel(e.target.value)} disabled={busy} aria-label="Model" title="Model used for answers">
                {modelList.models.map((m) => <option key={keyOf(m)} value={keyOf(m)}>{m.label}</option>)}
              </select>
            )}
            <label className="toggle" title="Answer from your uploaded documents. Turn off for general chat, coding and file creation.">
              <input type="checkbox" checked={useDocs} onChange={(e) => toggleDocs(e.target.checked)} />
              My documents
            </label>
            <label
              className={`toggle ${config.webSearch?.enabled ? "" : "off"}`}
              title={config.webSearch?.enabled ? "Also search the web for each question" : config.webSearch?.reason || "Web search is not configured"}
            >
              <input type="checkbox" checked={webOn} disabled={!config.webSearch?.enabled} onChange={(e) => toggleWeb(e.target.checked)} />
              Search the web
            </label>
            {activeId && (
              <details className="menu">
                <summary>Export</summary>
                <div>
                  <a href={`/api/conversations/${activeId}/export?format=md`}>Markdown</a>
                  <a href={`/api/conversations/${activeId}/export?format=pdf`}>PDF</a>
                  <a href={`/api/conversations/${activeId}/export?format=docx`}>Word</a>
                </div>
              </details>
            )}
            {messages.length > 0 && <button className="ghost" onClick={newChat} disabled={busy}>New chat</button>}
          </div>
        </header>

        <div className="thread">
          {messages.length === 0 && (
            <div className="intro">
              <h2>How can I help?</h2>
              <p>Chat, search the web, write code, or ask for a Word, PDF, Excel or PowerPoint file. Drag a file into the box to ask about it.</p>
              <div className="chips">
                {SUGGESTIONS.map((t) => <button key={t} className="chip" onClick={() => setInput(t)}>{t}</button>)}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "user" && m.attachments?.length > 0 && (
                <div className="attachrow">{m.attachments.map((a) => <span key={a.docId} className="attach">{a.filename}</span>)}</div>
              )}
              {m.role === "user" ? <p>{m.content}</p> : m.content ? <Markdown text={m.content} /> : <p className="thinking">Thinking… the first reply can take a minute on a local model.</p>}
              {m.files?.map((f) => (
                <a key={f.id} className="filecard" href={`/api/files/${f.id}`} download={f.name}>
                  <strong>{f.name}</strong><span>{fmtSize(f.size)} · Download</span>
                </a>
              ))}
              {m.notice && <p className="notice">{m.notice}</p>}
              {!busy && i === lastAsstIdx && m.content && <div className="msgtools"><button className="ghost" onClick={regenerate}>Regenerate</button></div>}
              {!busy && i === lastUserIdx && <div className="msgtools"><button className="ghost" onClick={editLast}>Edit</button></div>}
              {m.sources?.length > 0 && (
                <details>
                  <summary>{m.sources.length} sources</summary>
                  <ol>
                    {m.sources.map((s) => (
                      <li key={s.n}>
                        <b>
                          {s.type === "web" && <em className="tag">web</em>}
                          {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.filename}</a> : s.filename}
                          {s.page ? `, p.${s.page}` : ""}
                        </b>
                        <span>{s.snippet}…</span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {error && <div className="error" role="alert">{error}</div>}

        <form onSubmit={onSubmit} className="composer">
          <div className="composer-main">
            {editing && (
              <div className="editing">Editing your last message; sending replaces it and its answer. <button type="button" className="link" onClick={() => { setEditing(false); setInput(""); }}>Cancel</button></div>
            )}
            {files.length > 0 && (
              <div className="attachrow">
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="attach">
                    {f.name}
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="inputrow">
              <button type="button" className="ghost" onClick={() => attachRef.current.click()} disabled={busy} title="Attach files">Attach</button>
              <input ref={attachRef} type="file" multiple hidden accept=".pdf,.docx,.csv,.txt,.md" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter adds a new line (ignore Enter while an IME is composing)
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(e); }
                }}
                placeholder="Ask anything, or say “make a Word doc about…”  (Shift+Enter for a new line)"
                aria-label="Question"
              />
              {busy
                ? <button type="button" className="stop" onClick={stop}>Stop</button>
                : <button className="primary" disabled={!input.trim()}>Ask</button>}
            </div>
            {status && <div className="status">{status}</div>}
          </div>
        </form>
      </main>
    </div>
  );
}
