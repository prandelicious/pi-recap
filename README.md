# pi-recap

Inline session recap for [pi](https://pi.dev). Mimics Claude Code's recap
feature — concise summaries injected into the conversation so you always know
where you left off.

```
※ recap: Compared Exa vs Firecrawl scraping a Lamudi condo listing. Firecrawl
  won — it pulled unit prices, floor areas, and 27 images that Exa missed.
  Next up: testing Exa's `extract` parameter on static HTML.
```

## Features

- **Session resume** — auto-recaps prior work when you `/resume` a session
- **Idle timeout** — auto-recaps after inactivity (default 5 min)
- **Manual** — `/recap` triggers a recap any time
- **LLM-generated** — concise 2–4 sentence summary via your current model
- **Fallback** — basic stats when no model is available
- **Persistence** — tracks what's been recapped across restarts and compactions

## Install

```bash
# From the project directory (recommended for team sharing)
pi install ./path/to/pi-recap

# Or symlink into global extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-recap

# Then reload
/reload
```

## Usage

| Command | Effect |
|---|---|
| `/recap` | Generate and inject recap now |
| `/recap off` | Disable auto-recap (idle + resume) |
| `/recap on` | Re-enable auto-recap |
| `/recap configure 10` | Set idle timeout to 10 minutes |

### Auto-recap on session resume

When you return to a session via `/resume`, a recap of prior work is injected
as the first message. This works best with named sessions (`/name`) so you
can pick the right one from the resume picker.

### Idle timeout

If you don't type anything for 5 minutes (configurable), a recap is injected
automatically. The timer resets on your next input and fires only once per
idle period — no spam.

## Display

Recaps render as inline custom messages in the conversation:

```
※ recap: Key actions, findings, and what comes next...
```

Styled dimmed with a bold `recap:` label and ※ icon, matching Claude Code's
visual pattern.

## Development

```bash
git clone <repo-url>
cd pi-agent-recap

# Test locally
pi -e ./index.ts

# Or symlink for persistent use
ln -s "$PWD" ~/.pi/agent/extensions/pi-agent-recap
```

### Peer dependencies

Pi ships these at runtime. List them as `peerDependencies` in your package:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

## License

MIT
