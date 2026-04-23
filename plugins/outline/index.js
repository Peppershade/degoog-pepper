let bangTemplate = "";
let slotTemplate = "";
let cfg = {};

const baseUrl = () => cfg.url?.replace(/\/$/, "") ?? "https://app.getoutline.com";
const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${cfg.apiKey}`,
});

async function search(query, limit = 5) {
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

// ── Bang command ─────────────────────────────────────────────────────────────

export default {
  name: "Outline Knowledge Base",
  description: "Search your Outline knowledge base",
  trigger: "kb",
  aliases: ["outline", "wiki", "docs"],

  settingsSchema: [
    {
      key: "url",
      label: "Outline URL",
      type: "url",
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
    bangTemplate = ctx.template;
  },

  configure(settings) {
    cfg = settings;
  },

  isConfigured() {
    return !!(cfg.apiKey && cfg.url);
  },

  async execute(args) {
    const query = args.trim();
    if (!query) return { title: "Outline", html: "<p>Enter a search query.</p>" };

    const results = await search(query, 8);
    if (!results.length) {
      return { title: `Outline: ${query}`, html: "<p>No results found.</p>" };
    }

    const items = results
      .map(
        ({ document: doc, context }) => `
        <li class="outline-item">
          <a class="outline-item-title" href="${docUrl(doc)}" target="_blank" rel="noopener">${doc.title}</a>
          ${context ? `<p class="outline-item-excerpt">${context}</p>` : ""}
        </li>`
      )
      .join("");

    const html = bangTemplate
      .replace("{{query}}", query)
      .replace("{{items}}", items)
      .replace("{{moreUrl}}", `${baseUrl()}/search/${encodeURIComponent(query)}`);

    return { title: `Outline: ${query}`, html };
  },
};

// ── Slot plugin ──────────────────────────────────────────────────────────────

export const slot = {
  id: "outline",
  name: "Outline Knowledge Base",
  position: "above-results",

  async init(ctx) {
    slotTemplate = await ctx.readFile("slot-template.html");
  },

  configure(settings) {
    cfg = settings;
  },

  async trigger(query) {
    if (!cfg.apiKey || !cfg.url) return false;
    try {
      const results = await search(query, 3);
      this._results = results;
      return results.length > 0;
    } catch {
      return false;
    }
  },

  async execute(query) {
    const results = this._results ?? [];

    const items = results
      .map(
        ({ document: doc, context }) => `
        <div class="outline-slot-item">
          <a href="${docUrl(doc)}" target="_blank" rel="noopener">${doc.title}</a>
          ${context ? `<span>${context}</span>` : ""}
        </div>`
      )
      .join("");

    const html = slotTemplate
      .replace("{{items}}", items)
      .replace("{{moreUrl}}", `${baseUrl()}/search/${encodeURIComponent(query)}`);

    return { html };
  },
};
