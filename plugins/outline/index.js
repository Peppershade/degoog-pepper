let slotTemplate = "";
let cfg = {};

const baseUrl = () => cfg.url?.replace(/\/$/, "") ?? "https://app.getoutline.com";
const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${cfg.apiKey}`,
});

async function search(query, limit = 3) {
  const res = await fetch(`${baseUrl()}/api/documents.search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.data ?? [];
}

function docUrl(doc) {
  return doc.url?.startsWith("http") ? doc.url : `${baseUrl()}${doc.url}`;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ESC[c]);

// Find the window of `size` chars in `text` that contains the most matches
// for the query words, then return it with leading/trailing ellipsis.
function extractSnippet(text, query, size = 380) {
  if (!text) return "";
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return text.slice(0, size);

  const lower = text.toLowerCase();

  // Collect all match positions across all query words
  const positions = [];
  for (const word of words) {
    const w = word.toLowerCase();
    let p = 0;
    while ((p = lower.indexOf(w, p)) !== -1) { positions.push(p); p += w.length; }
  }

  if (!positions.length) return text.slice(0, size);

  // Slide a window and pick the start with the most matches inside it
  positions.sort((a, b) => a - b);
  let bestStart = positions[0];
  let bestCount = 0;
  for (let i = 0; i < positions.length; i++) {
    let count = 0;
    for (let j = i; j < positions.length && positions[j] < positions[i] + size; j++) count++;
    if (count > bestCount) { bestCount = count; bestStart = positions[i]; }
  }

  const start = Math.max(0, bestStart - 60);
  const end   = Math.min(text.length, start + size);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

// Convert a markdown snippet to safe HTML, preserving code blocks.
// Highlights query terms with <b> outside of code.
function renderExcerpt(text, query) {
  if (!text) return "";

  // Stash code blocks so we don't touch their contents
  const stash = [];
  const save = (html) => { const i = stash.length; stash.push(html); return `\x00${i}\x00`; };

  let s = text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      save(`<pre><code>${escHtml(code.trim())}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, code) =>
      save(`<code>${escHtml(code)}</code>`));

  // Strip markdown syntax from surrounding prose
  s = s
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[>\-*+]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Highlight query terms in the prose (not inside stash placeholders)
  if (query) {
    const words = query.trim().split(/\s+/).filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (words.length)
      s = s.replace(new RegExp(`(${words.join("|")})`, "gi"), "<b>$1</b>");
  }

  // Restore stashed code
  return s.replace(/\x00(\d+)\x00/g, (_, i) => stash[+i]);
}

export const slot = {
  id: "outline",
  name: "Outline Knowledge Base",
  position: "above-results",

  settingsSchema: [
    {
      key: "url",
      label: "Outline URL",
      type: "text",
      placeholder: "https://app.getoutline.com",
      description: "Your Outline instance URL",
      required: true,
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      description: "Create one in Outline → Settings → API & Apps",
      required: true,
      secret: true,
    },
  ],

  async init(ctx) {
    slotTemplate = await ctx.readFile("slot-template.html");
  },

  configure(settings) {
    cfg = settings;
  },

  async trigger(query) {
    if (!cfg.apiKey || !cfg.url) return false;
    try {
      const results = await search(query);
      this._results = results;
      this._query   = query;
      return results.length > 0;
    } catch {
      return false;
    }
  },

  async execute(query) {
    const q = this._query ?? query;
    const items = (this._results ?? [])
      .map(({ document: doc }) => {
        const excerpt = renderExcerpt(extractSnippet(doc.text || "", q), q);
        return `
        <div class="outline-slot-item">
          <a href="${docUrl(doc)}" target="_blank" rel="noopener">${escHtml(doc.title)}</a>
          ${excerpt ? `<div class="outline-slot-excerpt">${excerpt}</div>` : ""}
        </div>`;
      })
      .join("");

    const html = slotTemplate
      .replace("{{items}}", items)
      .replace("{{moreUrl}}", `${baseUrl()}/search/${encodeURIComponent(query)}`);

    return { html };
  },
};
