# Changelog

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
