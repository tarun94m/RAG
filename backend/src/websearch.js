// Web search adapters. Pick one in .env:
//   WEB_SEARCH_PROVIDER = tavily | brave | searxng
//   TAVILY_API_KEY / BRAVE_API_KEY / SEARXNG_URL (e.g. http://localhost:8080)
//   WEB_RESULTS = how many results to use (default 4)
import { loadUrlDocs } from "./loaders.js";

const env = process.env;
const N = () => Number(env.WEB_RESULTS || 4);

export function webSearchStatus() {
  const p = (env.WEB_SEARCH_PROVIDER || "").toLowerCase();
  if (!p) return { enabled: false, reason: "Set WEB_SEARCH_PROVIDER in the backend .env to enable web search." };
  if (p === "tavily") return env.TAVILY_API_KEY ? { enabled: true, provider: p } : { enabled: false, reason: "TAVILY_API_KEY is missing." };
  if (p === "brave") return env.BRAVE_API_KEY ? { enabled: true, provider: p } : { enabled: false, reason: "BRAVE_API_KEY is missing." };
  if (p === "searxng") return env.SEARXNG_URL ? { enabled: true, provider: p } : { enabled: false, reason: "SEARXNG_URL is missing." };
  return { enabled: false, reason: `Unknown WEB_SEARCH_PROVIDER "${p}".` };
}

async function getJson(label, url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`);
  return res.json();
}

const adapters = {
  // Returns content excerpts already, so no page fetching needed.
  async tavily(query) {
    const data = await getJson("Tavily", "https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: N(), search_depth: "basic" }),
    });
    return (data.results || []).map((r) => ({ title: r.title, url: r.url, text: r.content || "", full: true }));
  },

  async brave(query) {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(N()));
    const data = await getJson("Brave Search", u, {
      headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
    });
    return (data.web?.results || []).map((r) => ({ title: r.title, url: r.url, text: r.description || "" }));
  },

  async searxng(query) {
    const u = new URL("/search", env.SEARXNG_URL);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    const data = await getJson("SearXNG", u);
    return (data.results || []).slice(0, N()).map((r) => ({ title: r.title, url: r.url, text: r.content || "" }));
  },
};

// Snippet-only providers: read the top pages so the model has real content, falling back to the snippet.
async function enrich(results) {
  return Promise.all(
    results.map(async (r) => {
      if (r.full) return r;
      try {
        const { docs } = await loadUrlDocs(r.url, 8000);
        return { ...r, text: docs[0].pageContent.slice(0, 3000) };
      } catch {
        return r;
      }
    })
  );
}

export async function webSearch(query) {
  const status = webSearchStatus();
  if (!status.enabled) throw new Error(status.reason);
  const results = (await adapters[status.provider](query)).filter((r) => r.url && r.text);
  const enriched = await enrich(results.slice(0, N()));
  return enriched.map((r) => ({ title: r.title || r.url, url: r.url, text: r.text.slice(0, 3000) }));
}
