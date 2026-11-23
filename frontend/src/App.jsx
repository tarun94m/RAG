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

const SUGGESTIONS = [
  "Write a Python script that renames all files in a folder by date",
  "Create a Word document with a one-page project proposal template",
  "Make an Excel sheet to track monthly expenses",
  "Explain how a hash map works, with a JavaScript example",
];

export default function App() {
  const [tab, setTab] = useState("chats");
  const [docs, setDocs] = useState([]);
  const [selected, setSelected] = useState([]); // empty = search all
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [config, setConfig] = useState({});
  const [useDocs, setUseDocs] = useState(() => {
    try { return localStorage.getItem("useDocs") === "1"; } catch { return false; }
  });
  const [web, setWeb] = useState(() => {
    try { return localStorage.getItem("webSearch") === "1"; } catch { return false; }
  });
  const [error, setError] = useState("");
  const fileRef = useRef();
  const endRef = useRef();

  const loadDocs = () =>
    api("/api/documents")
      .then((d) => {
        setDocs(d);
        setSelected((sel) => sel.filter((id) => d.some((x) => x.docId === id)));
      })
      .catch((e) => setError(e.message));
  const loadConversations = () =>
    api("/api/conversations").then(setConversations).catch((e) => setError(e.message));

  useEffect(() => {
    loadDocs(); loadConversations();
    api("/api/config").then(setConfig).catch(() => {});
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const webOn = Boolean(config.webSearch?.enabled) && web;
  const toggleDocs = (v) => {
    setUseDocs(v);
    try { localStorage.setItem("useDocs", v ? "1" : "0"); } catch { /* ignore */ }
  };
  const toggleWeb = (v) => {
    setWeb(v);
    try { localStorage.setItem("webSearch", v ? "1" : "0"); } catch { /* ignore */ }
  };

  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

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

  // ----- conversations -----
  function newChat() {
    if (busy) return;
    setActiveId(null); setMessages([]); setError("");
  }

  async function openChat(id) {
    if (busy || id === activeId) return;
    try {
      const c = await api(`/api/conversations/${id}`);
      setActiveId(id); setMessages(c.messages); setError("");
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

  async function send(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "", sources: [], files: [] }]);
    setInput(""); setBusy(true); setError("");
    try {
      const res = await fetch("/api/chat", json("POST", { question, conversationId: activeId, docIds: selected, web: webOn, useDocs }));
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
      setError(err.message);
      setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -2) : m));
    } finally { setBusy(false); loadConversations(); }
  }

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
            <ul className="list">
              {conversations.length === 0 && <li className="empty">No saved chats yet. Ask a question to start one.</li>}
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

      <main className="chat">
        <header className="bar">
          <span>{scope}</span>
          <div className="barright">
            <label className="toggle" title="Answer from your uploaded documents. Turn off for general chat, coding and file creation.">
              <input type="checkbox" checked={useDocs} onChange={(e) => toggleDocs(e.target.checked)} />
              My documents
            </label>
            <label
              className={`toggle ${config.webSearch?.enabled ? "" : "off"}`}
              title={config.webSearch?.enabled ? "Also search the web for each question" : config.webSearch?.reason || "Web search is not configured"}
            >
              <input
                type="checkbox"
                checked={webOn}
                disabled={!config.webSearch?.enabled}
                onChange={(e) => toggleWeb(e.target.checked)}
              />
              Search the web
            </label>
            {messages.length > 0 && <button className="ghost" onClick={newChat} disabled={busy}>New chat</button>}
          </div>
        </header>
        <div className="thread">
          {messages.length === 0 && (
            <div className="intro">
              <h2>How can I help?</h2>
              <p>Chat, search the web, write code, or ask for a Word, PDF or Excel file. Turn on “My documents” to answer from your uploads.</p>
              <div className="chips">
                {SUGGESTIONS.map((t) => <button key={t} className="chip" onClick={() => setInput(t)}>{t}</button>)}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "user" ? <p>{m.content}</p> : m.content ? <Markdown text={m.content} /> : <p className="thinking">Thinking… the first reply can take a minute on a local model.</p>}
              {m.files?.map((f) => (
                <a key={f.id} className="filecard" href={`/api/files/${f.id}`} download={f.name}>
                  <strong>{f.name}</strong><span>{fmtSize(f.size)} · Download</span>
                </a>
              ))}
              {m.notice && <p className="notice">{m.notice}</p>}
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
        <form onSubmit={send} className="composer">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything, or say “make a Word doc about…”" aria-label="Question" />
          <button className="primary" disabled={busy || !input.trim()}>Ask</button>
        </form>
      </main>
    </div>
  );
}
