# degoog-pepper — Plugin Store

Community plugins for [degoog](https://fccview.github.io/degoog), a self-hosted, customizable search engine.

## Installation

Copy any plugin folder from `plugins/` into your degoog instance's plugin directory (default: `data/plugins/`):

```
cp -r plugins/outline /path/to/degoog/data/plugins/
```

Then restart degoog. Configure the plugin under **Settings → Plugins**.

## Plugins

| Plugin | Types | Triggers | Requires config |
|--------|-------|----------|-----------------|
| [Outline](plugins/outline) | bang, slot | `!kb`, `!outline`, `!wiki`, `!docs` | Yes |

## Plugin types

- **bang** — triggered by `!keyword` in the search bar
- **slot** — injects a panel into search results when relevant
- **tab** — adds a new tab to the search results tab bar
- **route** — exposes a custom HTTP endpoint under `/api/plugin/<name>/`

## Contributing

Each plugin lives in its own folder under `plugins/`. Add a record to `store.json` when submitting a new plugin.

```
plugins/
  your-plugin/
    index.js          ← required
    template.html     ← optional, for bang commands
    slot-template.html← optional, for slot panels
    style.css         ← optional
    author.json       ← optional
```

See the [degoog plugin docs](https://fccview.github.io/degoog/plugins.html) for the full API reference.
