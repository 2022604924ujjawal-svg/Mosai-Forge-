# TUI Sessions Roadmap

> Embed Claude Code TUI inside Clay sessions to keep usage in the Interactive billing bucket (post 2026-06-15 Anthropic Agent SDK split).

## Background

Starting 2026-06-15, Anthropic splits Claude subscription billing into two buckets:

- **Interactive bucket** (existing subscription limits): `claude.ai` chat, interactive Claude Code in terminal, Claude Cowork.
- **Programmatic bucket** (new monthly credit at full API rates): Claude Agent SDK, `claude -p`, GitHub Actions, third-party apps built on the Agent SDK.

Per-plan programmatic credit caps: Pro $20, Max 5x $100, Max 20x $200. Credits expire monthly, no rollover. Once exhausted, additional usage requires explicit "extra usage" opt-in at standard API rates.

Clay currently calls `@anthropic-ai/claude-agent-sdk` `query()` programmatically. This falls 100% into the new Programmatic bucket. Heavy Clay users would exhaust their credit in days.

## Strategy

Pivot to driving `claude` CLI in interactive PTY mode, so usage stays in the Interactive bucket. Clay becomes a session manager + terminal host around the real Claude Code TUI.

The existing GUI session flow (SDK-based custom chat UI) stays available for users who prefer it or who use API keys. A new "TUI session" mode runs `claude` in an embedded xterm.

## MVP Scope

In:
- "+ TUI" button alongside existing "+ GUI" button on session list.
- TUI session view: existing title bar (title + open-terminal button) + xterm.js running `claude`.
- Session ID dictated by Clay (`--session-id <uuid>`) for stable resume.
- Title auto-followed from jsonl `ai-title` / `custom-title` events.
- Single-user mode first.

Out (MVP):
- Input bar overlay / proxy typer.
- Image input helper.
- Context selection overlay.
- In-session search.
- Cost / message metadata for TUI sessions.
- Multi-user OS isolation (later phase).
- Background-keep across session switches (later phase).
- LRU PTY recycling (later phase).

## Decisions Locked

| Item | Decision |
|---|---|
| Session ID | Clay generates UUID, injects via `--session-id` |
| Display title | Followed from jsonl `ai-title` / `custom-title` events |
| `--name` flag | Not used (avoid suppressing auto ai-title) |
| Backgrounding | Keep PTY alive after detach (Phase 3+); MVP can kill on detach |
| Multi-user | Reuse `claude-worker.js` pattern with `node-pty` inside worker (Phase 5) |
| Model picker | Inside `claude` (`/model`). Clay UI not involved. |
| Codex adapter | Untouched. GUI flow preserved. |

## Data Model

Extend `lib/sessions.js` session meta:

```js
{
  localId,
  cliSessionId,    // UUID we generate for TUI; for GUI use existing flow
  title,           // existing user-set
  createdAt,
  vendor,          // 'claude' | 'codex'
  mode,            // NEW: 'gui' | 'tui' (default 'gui')
  aiTitle,         // NEW: captured from jsonl
  customTitle,     // NEW: captured from jsonl
  ...
}
```

Display title resolution: `customTitle > aiTitle > title > "(no title)"`.

TUI sessions do not use `history[]` (no stream events to record).

## WebSocket Protocol Additions

**Client to Server**
| Type | Payload |
|---|---|
| `new_session` (extended) | `{ mode: 'tui', projectId, cwd }` |
| `tui_attach` | `{ sessionId }` |
| `tui_detach` | `{ sessionId }` |
| `pty_input` | `{ sessionId, data }` |
| `pty_resize` | `{ sessionId, cols, rows }` |

**Server to Client**
| Type | Payload |
|---|---|
| `pty_data` | `{ sessionId, data }` |
| `pty_exit` | `{ sessionId, code }` |
| `session_meta_update` | `{ sessionId, aiTitle?, customTitle? }` |

PTY process lifecycle is independent of WS attach/detach. Attach/detach controls only screen rendering and live data delivery.

## New Files

| File | Role |
|---|---|
| `lib/yoke/adapters/claude-pty.js` | PTY adapter implementing YOKE contract (slim subset for TUI mode) |
| `lib/yoke/claude-pty-worker.js` | OS user isolation worker (Phase 5); spawns `claude` via `node-pty` |
| `lib/claude-jsonl-watcher.js` | Tails `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, broadcasts title updates |
| `lib/public/modules/session-tui-view.js` | xterm.js mount, WS PTY relay, resize handling |
| `lib/public/vendor/xterm/*` | xterm.js + fit addon bundle |

## Modified Files

| File | Change |
|---|---|
| `lib/yoke/index.js` | `createAdapter({ vendor, mode })` returns PTY adapter when `mode === 'tui'` |
| `lib/project-sessions.js` | `new_session` accepts `mode: 'tui'`; creates record without spawning SDK |
| `lib/sessions.js` | Schema extension, helpers `createTuiSession`, `updateTitleFromJsonl` |
| `lib/public/modules/sidebar-sessions.js` | Split "+ New" into "+ GUI" / "+ TUI"; per-item mode icon |
| `lib/public/modules/app-messages.js` | Route new message types |
| `lib/public/modules/home-chat.js` (or `app-rendering.js`) | Swap chat renderer vs TUI view based on session mode |
| `lib/ws-schema.js` | Register new message types (informational) |

## PTY Lifecycle

```
User clicks "+ TUI"
  Server: generate UUID, create session record, request worker spawn
  Worker: node-pty.spawn('claude', ['--session-id', uuid], { cwd, uid, gid, env })
  Worker: start jsonl watcher on ~/.claude/projects/<cwd>/<uuid>.jsonl
  Client: session auto-activates, sends tui_attach, mounts xterm

User clicks different session
  Client: sends tui_detach, unmounts xterm
  PTY remains alive in worker (Phase 3+)
  Output accumulates in ring buffer

User returns to TUI session
  tui_attach: server dumps ring buffer, then resumes live stream

User deletes session
  PTY kill, worker cleanup, jsonl watcher stop
  ~/.claude/projects/.../<uuid>.jsonl preserved (belongs to Claude Code)
```

Ring buffer: per-session ~256KB. Restores output missed during detach.

## jsonl Watcher

Use `chokidar` (check if already a Clay dependency; otherwise add). Tail `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. On new lines, parse JSON and react to:

- `type: "ai-title"` -> update `session.aiTitle`, broadcast `session_meta_update`.
- `type: "custom-title"` -> update `session.customTitle`, broadcast.

Watcher tolerates unknown types (forward-compat with Claude Code format changes). Failures only result in stale titles, never fatal.

## Multi-user Isolation (Phase 5)

Mirror existing `claude-worker.js`:

- Daemon spawns `claude-pty-worker.js` as target OS user.
- Unix domain socket IPC between daemon and worker.
- Worker calls `node-pty.spawn` under that user's UID/GID.
- Daemon relays stdin/stdout/resize over WS, never touches PTY directly.

Single-user mode skips worker; daemon hosts `node-pty` directly.

## New Dependencies

| Package | Use | Note |
|---|---|---|
| `node-pty` | PTY spawn | Native module. Prebuilt binaries available. macOS/Linux/Windows. |
| `@xterm/xterm` | Browser terminal | ~250KB |
| `@xterm/addon-fit` | Resize handling | Small |
| `chokidar` | jsonl watch | May already be a Clay dependency; verify |

## Phased Build Plan

### Phase 1: First functional MVP (merged skeleton + PTY)
- Add `mode` field to session meta and persistence.
- Split sidebar "+ New" button into "+ GUI" / "+ TUI"; per-item mode icon.
- Session view router: GUI mode renders existing chat, TUI mode renders xterm.
- Integrate `node-pty` directly in daemon (single-user, no worker yet).
- Implement `tui_attach`, `tui_detach`, `pty_input`, `pty_data`, `pty_resize`, `pty_exit`.
- Bundle xterm.js + fit addon, mount with bidirectional data flow.
- Window resize triggers PTY resize.
- Single session at a time, no background-keep (PTY killed on detach).

Outcome: click "+ TUI", see `claude` running in browser. First testable state.

### Phase 2: Background-keep + ring buffer
- PTY survives detach.
- Ring buffer per session.
- On reattach: dump buffer, then resume live stream.

Outcome: smooth session switching without losing context.

### Phase 3: jsonl watcher
- Auto-follow title from `ai-title` / `custom-title`.
- Broadcast `session_meta_update`.
- Sidebar reflects title in real time, including external `/title` changes.

Outcome: titles stay in sync with Claude Code's view.

### Phase 4: Multi-user
- Split out `claude-pty-worker.js`.
- Daemon to worker Unix socket relay.
- Verify OS user isolation.

Outcome: multi-user Clay instances safe.

### Phase 5: Polish
- Detect `/exit` and similar; PTY hosts a shell that runs `claude`, so exit drops to shell.
- Error states: missing binary, permission failure.
- Session deletion cleanup.
- Keyboard shortcuts.

## Risks

| Risk | Mitigation |
|---|---|
| `node-pty` native build failure on some Linux distros | Verify prebuilt binaries; friendly install-script error |
| Fast `claude` output saturating WS | Worker batches output in ~16ms windows |
| Multiple browser tabs attached to same TUI session | First cut: single-attach lock; later allow multi-viewer |
| Claude Code changes `--session-id` semantics in future | Isolated in YOKE adapter; single point of change |
| jsonl format change | Watcher ignores unknown types; only titles go stale |

## Open Questions

- `chokidar` already a dependency? Verify before adding.
- Do we need a dedicated kill switch for TUI sessions (e.g., "force kill" button) for stuck PTYs?
- Should TUI session view expose copy-on-select or selection model integration with browser clipboard? Default xterm.js behavior may be sufficient for MVP.
