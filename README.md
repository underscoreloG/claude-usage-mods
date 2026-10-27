# claude-usage-mods

Five Claude Code mods for keeping an eye on usage, cost, subagents and background tasks while you work, and for switching what is loaded on or off.

| Mod | What it does | Toggle |
|---|---|---|
| `usage-band` | One-line band above the prompt: model, context fill, rate limits, cache hit, cost, optional buttons for the panes | `/usageband` |
| `agents-band` | Live rows for subagents, background shells and monitors, and linked sessions, stacked above the usage band | `/agentsband` |
| `flight-recorder` | Pane with a live timeline of each turn, per lane (main + subagents) | `/flight-recorder` |
| `switchboard` | Pane with on/off switches for mods, plugins, skills and MCP servers | `/switchboard` |
| `session-hud` | Pane with session cards: context, cost, cost per turn, tools used, files changed, what runs now | `/hud` |

## usage-band and agents-band

![usage-band line above the prompt: model, context, 5h and 7d limits, cache hit, cost](docs/bands.png)

**usage-band** is the bottom row: one line that answers "how much room and budget do I have left?" without running `/usage` or `/context`. From left to right:

- **Model** - the model the main loop is running, in Claude orange.
- **Context** - a bar, then how full the context window is in percent, then tokens used / window size.
- **5h / 7d** - percent used of each rate limit, then a countdown to its reset (`↻ 1h24m`). The `5h` and `7d` labels are blue.
- **Cache hit** - the share of this session's input tokens the prompt cache served, counting every response, subagents included (`56% hit`). It shows from the first response.
- **Cost** - what this session has cost at API prices, after a 💰, in gold.

The sections are spread evenly with a `│` midway between each pair. Context and limit percentages turn yellow at 50% and red at 80%; the cache hit rate goes the other way: green from 80%, yellow from 50%, red below. The band refreshes while you are idle, so the countdowns stay accurate, and it steps aside when a survey or question takes that spot.

**Buttons** sit at the end of the line, and they are off by default. Each one shows only once you turn it on and while its mod is loaded:

- **flight-recorder** (✈) opens the flight recorder pane.
- **switchboard** (⚙️) opens the Switchboard pane without adding a command to the transcript.
- **hud** (a gauge on desktop, `◆` in the terminal) opens the `session-hud` pane, also without a command in the transcript.

| Command | What it does |
|---|---|
| `/usageband` | Hides or shows the whole band |
| `/usageband open <pane>` | Opens that pane (`flight-recorder`, `switchboard` or `hud`), with or without its button |
| `/usageband <button>` | Turns that button on when off, off when on (`flight-recorder`, `switchboard` or `hud`). Kept in new sessions |
| `/usageband buttons` | Lists the buttons, on or off, and which mods aren't loaded |

The command's hint lists the names as you type; the slash menu can't autocomplete arguments. Each pane's own command (`/flight-recorder`, `/switchboard`, `/hud`) opens it too. On desktop the buttons are 16 px grey icons, and the terminal draws them as glyphs.

**agents-band** is the top block. It appears only while there is something to show (subagents, background tasks or linked sessions), so it costs no space the rest of the time. Each subagent row shows:

- spinner while running, `✓` when done, `✗` when failed
- agent type and the task it was given
- model, then what it is doing right now (`thinking` or `▸ ToolName`)
- tool calls so far, tokens, elapsed time

The header counts running and finished agents. A finished agent stays visible for 20 seconds, then drops off. Up to 6 rows are shown.

**Background tasks**. Shell commands sent to the background (`run_in_background`, or Ctrl+B) and `Monitor` watches, from the main loop or any subagent, get a block of their own under the subagents:

- spinner while running, `✓` completed, `✗` failed, `■` killed
- `shell` or `monitor`, then the call's description (or its command)
- status and elapsed time

A row opens when the call returns a background task id. It closes when that task's notification arrives, or when `TaskStop` stops it, then lingers 20 seconds like a finished subagent. The end is read from the notification text in whichever conversation it lands, the main one or the subagent that started the task, so a task whose notification never reaches this session stays `running` until the session restarts.

**Linked sessions** (desktop app only). Sessions this one started with `start_session`, and the ones those started, get a block of their own under the subagents:

- spinner while the session is working, `○` when idle
- its short name and title
- model, `working` or `idle Nm ago`, and context fill (`ctx 23%`)

The data comes from the desktop app's `ccd_session_mgmt` MCP server (`list_sessions` with `linked: true`, `get_session`, `get_usage`), polled every 5 seconds. Archived sessions, the parent and sibling sessions are left out. In a terminal session that server does not exist: the first call says so and polling stops. Unlike subagents, a session's current tool and token count are not shown, since the server does not report them.

## flight-recorder

![flight-recorder pane, text view, showing one turn with the main lane and two subagent lanes](docs/flight-recorder.png)

A side pane that records what happens inside each turn, so you can see where time and tokens went:

- **Turn header** - turn number, duration, cost, model requests, tool calls, total tokens, subagent count.
- **Lane timeline** - one row per lane: `main` plus each subagent (`gene a59e` = general-purpose agent `a59e…`). Bars are model requests, colored by model (opus, sonnet, haiku, fable). Tool calls are drawn on top, colored by kind (read, edit, shell, other). Dots mean nothing was running in that lane at that moment, for example main idle while its subagents work.
- **MODELS** - token share per model family for the turn.
- **Per-lane table** - requests, tool calls and tokens for each lane.

In the screenshot, main (opus) used 92% of the tokens for the turn and the two sonnet subagents only 8%. A spend split like that is the thing this pane makes easy to see.

Two views: **Text** (default, works in the terminal too) and **Dashboard** (SVG charts: cost per turn, tokens by model, top tools; desktop only). `/flight-recorder text` or `/flight-recorder dashboard` opens the pane on that view. Earlier turns are kept below the current one.

## switchboard

A side pane with an on/off switch for everything loaded into a session, in four tabs (`1`-`4` to switch):

| Tab | Lists | Off means | Takes effect |
|---|---|---|---|
| **Mods** | Mods loaded from `CLAUDE_CODE_PLUGIN_DIRS` and the session's dev-mods folder | Its `hooks/hooks.json` is backed up and pointed at a no-op stub; on restores it | Next session (dev-mods: at once) |
| **Plugins** | Installed marketplace plugins | `claude plugin disable` (on: `enable`) | Next session |
| **Skills** | Your skills, project skills, and each enabled plugin's | `Skill(<name>)` is added to `permissions.deny` in `~/.claude/settings.json` | Next session |
| **MCP** | MCP servers whose tools Claude can call, grouped by server | Switchboard refuses every call to that server and marks its tools as switched off | At once |

- Mods that open panels also get an eye button: hiding blocks their panes without switching them off.
- The first time it edits `~/.claude/settings.json` it keeps the original as `settings.json.switchboard-backup`.
- A blocked skill stays in Claude's list; calls to it are refused. A switched-off MCP server's tools are still listed, marked off.
- On desktop the switches are drawn as SVG pills; the terminal gets `━━● ON` / `○── OFF`.
- `/switchboard on|off|hide|show <mod>` does the same from the prompt.

## session-hud

![session-hud pane on desktop after a turn of work: context, cost, cost per turn, tools, files changed, now](docs/session-hud.png)

A side pane with one card per question, opened with `/hud` or the band's HUD button (Esc closes it). The button opens it with no `/hud` line in the transcript:

- **Context** - percent and tokens used of the window, with a meter that turns amber at 60% and red at 85%.
- **Cost** - what this session has cost, and what the last turn cost.
- **Cost per turn** - one bar per turn, with the last and average cost.
- **Tools** - the six busiest tools, each with its own color.
- **Files changed** - files Claude edited or wrote, with how many times.
- **Now** - the tool running right now, cut to one line of 60 characters. Keys, tokens and email addresses are masked before the cut.

It only observes and draws: no tool call or prompt is changed or refused. Counters live in the mod, so a reload of the mod starts them again from zero.

Desktop and mobile get cards that fill the pane, SVG bars and a gap between cards; on a narrow pane Context and Cost stack. The terminal gets fixed-width cards and `Raster` bars. The layout is picked by `e.surface`, not by which elements the surface offers, since the desktop table carries `Raster` too.

Trimmed from the `/hud` dashboard of StackSprint's [session-guard](https://github.com/stacksprint-io/claude-code-playbook/tree/main/mods/session-guard) 0.1.2 (MIT, see `session-hud/LICENSE`), without its status band, budget guard and recording mode.

## Install

1. Clone the repo anywhere, for example `~/.claude/mods`.
2. Point `CLAUDE_CODE_PLUGIN_DIRS` at the mods you want (`;` on Windows, `:` elsewhere), for example in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/usage-band:/path/to/agents-band:/path/to/flight-recorder:/path/to/switchboard:/path/to/session-hud"
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
