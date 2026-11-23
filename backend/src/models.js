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

export async function makeChat() {
  const provider = env.CHAT_PROVIDER || "ollama";
  const temperature = Number(env.TEMPERATURE ?? 0.2);

  if (provider === "openai") {
    const { ChatOpenAI } = await import("@langchain/openai");
    return new ChatOpenAI({ model: env.CHAT_MODEL || "gpt-4o-mini", temperature });
  }
  if (provider === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({ model: env.CHAT_MODEL || "claude-haiku-5-5", temperature });
  }
  if (provider === "google") {
    const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
    return new ChatGoogleGenerativeAI({
      model: env.CHAT_MODEL || "gemini-2.5-flash",
      apiKey: env.GOOGLE_API_KEY,
      temperature,
    });
  }
  if (provider === "ollama") {
    const { ChatOllama } = await import("@langchain/ollama");
    return new ChatOllama({
      model: env.CHAT_MODEL || "llama3.2",
      baseUrl: env.OLLAMA_BASE_URL || "http://localhost:11434",
      numCtx: Number(env.OLLAMA_NUM_CTX || 8192),
      temperature,
    });
  }
  throw new Error(`Unknown CHAT_PROVIDER "${provider}"`);
}
