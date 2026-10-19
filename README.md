# claude-usage-mods

Three Claude Code mods for keeping an eye on usage, cost and subagents while you work.

| Mod | What it does |
|---|---|
| `usage-band` | One-line band above the prompt: context fill, session cost, 5h and 7d rate limits with reset countdowns, model. `/usage-band` toggles it. |
| `agents-band` | Live rows above the prompt for running subagents: type, task, model, current tool, tokens, time. Stacks above `usage-band`. |
| `flight-recorder` | Live pane with a timeline of each turn: model requests and tool calls per lane (main + subagents), cost, tokens. Text and dashboard views. |

## Install

1. Clone the repo anywhere, for example `~/.claude/mods`.
2. Point `CLAUDE_CODE_PLUGIN_DIRS` at the mods you want (`;` on Windows, `:` elsewhere), for example in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/usage-band:/path/to/agents-band:/path/to/flight-recorder"
  }
}
```

3. Restart Claude Code.

## Layout

Each mod has the same shape:

- `.claude-plugin/plugin.json` - manifest
- `hooks/hooks.json` + `hooks/register.tsx` - the mod itself
- `tests/` - tests using `claude-code/testing`
- `types/index.d.ts` - the mod's own public types

`.claude-plugin/types/` holds the Claude Code SDK type stubs. They are generated locally and git-ignored, so `tsconfig.json` only resolves once Claude Code has regenerated them (for example by asking it to work on the mod).
