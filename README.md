# pi-recap

Inline session recap for [pi](https://pi.dev). Mimics Claude Code's recap
feature — concise summaries injected into the conversation so you always know
where you left off.

```
※ recap: Refactored the auth middleware to use JWT-only tokens and removed
  the legacy session fallback. Updated 3 route handlers. Next: adding refresh
  token rotation before the security audit.
```

## Features

- **Session resume** — auto-recaps prior work when you `/resume` a session
- **Session fork** — auto-recaps when you `/fork` into a new branch
- **Idle timeout** — auto-recaps after inactivity (default 5 min, configurable)
- **Manual** — `/recap` triggers a recap any time, even when auto-recap is off
- **LLM-generated** — concise 2–4 sentence summary via your current model
- **Fallback** — basic stats when no model is available
- **Persistence** — tracks what's been recapped across restarts and compactions
- **Status command** — check current configuration with `/recap status`

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
| `/recap off` | Disable auto-recap (idle + resume + fork) |
| `/recap on` | Re-enable auto-recap |
| `/recap configure 10` | Set idle timeout to 10 minutes |
| `/recap status` | Show current config (enabled/disabled, timeout, last recap) |

### Auto-recap on session resume

When you return to a session via `/resume` or `/fork`, a recap of prior work
is injected as the first message. This works best with named sessions
(`/name`) so you can pick the right one from the resume picker.

### Idle timeout

If you don't type anything for 5 minutes (configurable), a recap is injected
automatically. The timer resets on your next input and fires only once per
idle period — no spam.

## Configuration

Global defaults are read from `~/.pi/agent/pi-recap.json` on startup:

```json
{
  "idleMinutes": 5,
  "enabled": true
}
```

Per-session settings (`/recap configure`, `/recap off`) override the file
config for that session. A template is available at `config-example.json`
in the project root.

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

# Install dev dependencies
bun install

# Type-check
bun run typecheck

# Run tests
bun run test

# Test locally
pi -e ./index.ts
```

### Scripts

| Command | Action |
|---|---|
| `bun run typecheck` | TypeScript strict check (`tsc --noEmit`) |
| `bun run test` | Run test suite (vitest) |
| `bun run test:watch` | Watch mode |

### Peer dependencies

Pi ships these at runtime. List them as `peerDependencies` in your package:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

## License

MIT
