// Turns a generated web project (index.html + css/js files) into one self-contained page for a sandboxed iframe.
const norm = (p) => {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/");
};

export function buildPreview(files) {
  const map = new Map(files.map((f) => [norm(f.path), f.content]));
  const indexPath = map.has("index.html") ? "index.html" : [...map.keys()].find((p) => /(^|\/)index\.html$/.test(p));
  if (!indexPath) return null;
  const dir = indexPath.includes("/") ? indexPath.slice(0, indexPath.lastIndexOf("/") + 1) : "";
  const lookup = (ref) => (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:") ? undefined : map.get(norm(dir + ref)));

  let html = map.get(indexPath);
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel=["']?stylesheet/i.test(tag)) return tag;
    const m = /href=["']?([^"'\s>]+)/i.exec(tag);
    const css = m && lookup(m[1]);
    return css != null ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*?)\bsrc=["']?([^"'\s>]+)["']?([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    const js = lookup(src);
    if (js == null) return tag;
    const attrs = `${a} ${b}`.replace(/\s+/g, " ").trim();
    return `<script${attrs ? " " + attrs : ""}>${js.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
  return html;
}
