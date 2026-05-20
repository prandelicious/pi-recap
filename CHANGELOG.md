# Changelog

## 1.1.0 (2026-05-20)

- **Feat**: Compaction-aware message slicing — `getRecentMessages` now detects
  compaction boundaries instead of scanning from the session start when
  `lastRecapEntryId` was compacted away
- **Feat**: Abort signal support — LLM recap requests are cancelled on session
  shutdown, preventing stale responses and stuck `generating` flags
- **Feat**: Session-scoped state — `sessionGen` counter and `resetSession()`
  guard against cross-session timer leaks and stale context references
- **Feat**: Fork recap — auto-recap now fires on `/fork` in addition to `/resume`
- **Feat**: Forced manual recap — `/recap` works even when auto-recap is off
- **Feat**: `/recap status` — new subcommand shows enabled/disabled, idle
  timeout, and whether a recap has been recorded
- **Feat**: Global config file — `~/.pi/agent/pi-recap.json` for default
  settings (see `config-example.json`)
- **Feat**: Prompt injection guard — conversation text is sanitized before
  LLM interpolation to prevent XML tag escaping
- **Feat**: Strict TypeScript — `tsconfig.json` with `strict`, 
  `noUncheckedIndexedAccess`, `noImplicitOverride`; zero type errors
- **Feat**: Test suite — 16 unit tests across 5 suites (vitest)
- **Dev**: Added `typecheck`, `test`, `test:watch` scripts; `files` field in
  `package.json` for npm publishing

## 1.0.2 (2026-05-18)

- **Fix**: Use `[User]:` marker check instead of raw text-length check
  (the old 40-char gate passed but serialized content wasn't conversational)
- **Fix**: Filter out LLM responses containing "no conversation provided"
- **Fix**: `simpleRecap` returns `null` instead of injecting "No recent activity"

## 1.0.1 (2026-05-18)

- Skip recap generation when conversation has no meaningful content
  (requires at least one user + one assistant message)

## 1.0.0 (2026-05-18)

- Initial release
- `/recap` command with manual trigger
- Auto-recap on session resume (`/resume`)
- Auto-recap on idle timeout (configurable, default 5 min)
- LLM-generated summaries with stats fallback
- Custom inline renderer (`※ recap:` with dim/bold styling)
- State persistence across restarts and compactions
- Commands: `/recap`, `/recap off|on`, `/recap configure <minutes>`
