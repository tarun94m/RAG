// Picks embedding + chat models from .env so you can switch providers without code changes.
//
// EMBEDDINGS_PROVIDER = ollama | google | openai   (default: ollama)
// CHAT_PROVIDER       = ollama | google | openai | anthropic   (default: ollama)
// Model names and EMBEDDING_DIMENSIONS can be overridden via env.
const env = process.env;

export async function makeEmbeddings() {
  const provider = env.EMBEDDINGS_PROVIDER || "ollama";

  if (provider === "openai") {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    return {
      embeddings: new OpenAIEmbeddings({ model: env.EMBEDDING_MODEL || "text-embedding-3-small" }),
      dimensions: Number(env.EMBEDDING_DIMENSIONS || 1536),
    };
  }
  if (provider === "google") {
    const { GoogleGenerativeAIEmbeddings } = await import("@langchain/google-genai");
    return {
      embeddings: new GoogleGenerativeAIEmbeddings({
        model: env.EMBEDDING_MODEL || "text-embedding-004",
        apiKey: env.GOOGLE_API_KEY,
      }),
      dimensions: Number(env.EMBEDDING_DIMENSIONS || 768),
    };
  }
  if (provider === "ollama") {
    const { OllamaEmbeddings } = await import("@langchain/ollama");
    return {
      embeddings: new OllamaEmbeddings({
        model: env.EMBEDDING_MODEL || "nomic-embed-text",
        baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434",
      }),
      dimensions: Number(env.EMBEDDING_DIMENSIONS || 768),
    };
  }
  throw new Error(`Unknown EMBEDDINGS_PROVIDER "${provider}"`);
}

const DEFAULT_NAMES = { openai: "gpt-4o-mini", anthropic: "claude-haiku-5-5", google: "gemini-2.5-flash", ollama: "llama3.2" };

export function defaultChatSpec() {
  const provider = env.CHAT_PROVIDER || "ollama";
  return { provider, model: env.CHAT_MODEL || DEFAULT_NAMES[provider] };
}

export async function makeChat(spec = defaultChatSpec()) {
  const { provider, model } = spec;
  const temperature = Number(env.TEMPERATURE ?? 0.2);

  if (provider === "openai") {
    const { ChatOpenAI } = await import("@langchain/openai");
    return new ChatOpenAI({ model, temperature });
  }
  if (provider === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({ model, temperature });
  }
  if (provider === "google") {
    const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
    return new ChatGoogleGenerativeAI({ model, apiKey: env.GOOGLE_API_KEY, temperature });
  }
  if (provider === "ollama") {
    const { ChatOllama } = await import("@langchain/ollama");
    return new ChatOllama({
      model,
      baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434",
      numCtx: Number(env.OLLAMA_NUM_CTX || 8192),
      keepAlive: env.OLLAMA_KEEP_ALIVE || "60m",
      temperature,
    });
  }
  throw new Error(`Unknown chat provider "${provider}"`);
}

// Models the person can pick in the UI: whatever Ollama has installed, plus hosted models whose key is set.
let cache = { at: 0, value: null };
export async function listModels() {
  if (cache.value && Date.now() - cache.at < 15000) return cache.value;
  const def = defaultChatSpec();
  const models = [];

  try {
    const base = env.OLLAMA_BASE_URL || "http://localhost:11434";
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    for (const m of j.models || []) {
      if (!/embed/i.test(m.name)) models.push({ provider: "ollama", model: m.name, label: `${m.name} · local` });
    }
  } catch { /* Ollama not reachable: just don't list local models */ }

  const hosted = [
    ["google", env.GOOGLE_API_KEY, env.GOOGLE_MODELS || DEFAULT_NAMES.google, "Gemini"],
    ["anthropic", env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODELS || "claude-haiku-5-5,claude-sonnet-5-5", "Claude"],
    ["openai", env.OPENAI_API_KEY, env.OPENAI_MODELS || DEFAULT_NAMES.openai, "OpenAI"],
  ];
  for (const [provider, key, names, label] of hosted) {
    if (!key) continue;
    for (const model of names.split(",").map((x) => x.trim()).filter(Boolean)) {
      models.push({ provider, model, label: `${model} · ${label}` });
    }
  }
  if (!models.some((m) => m.provider === def.provider && m.model === def.model)) {
    models.unshift({ ...def, label: `${def.model} · default` });
  }
  cache = { at: Date.now(), value: { default: def, models } };
  return cache.value;
}
