# Kiro CLI Integration — Summary

> Adds AWS **Kiro CLI** as a first-class agent runtime in Clay, alongside
> Claude Code and Codex, through the YOKE adapter layer.

## Goal

Make `kiro-cli` usable inside Clay exactly like Claude Code or Codex: pick the
vendor, create a session, chat, approve tools, and switch models — with no
user-visible difference between runtimes.

## How it works

Kiro CLI exposes the **Agent Client Protocol (ACP)** via `kiro-cli acp` —
standard JSON-RPC 2.0 over stdin/stdout, the same editor-agnostic agent
protocol used by Zed. This mirrors the transport strategy Clay already uses for
`codex app-server`.

```
Clay session (vendor=kiro)
    -> YOKE Kiro Adapter   (lib/yoke/adapters/kiro.js)
    -> KiroAcpServer       (lib/yoke/kiro-acp-server.js)  spawn `kiro-cli acp`
    -> kiro-cli binary     (JSON-RPC 2.0 over stdio)
```

### Protocol lifecycle (verified against kiro-cli 2.18.1 with the v3 engine)

| Step | Method | Notes |
|------|--------|-------|
| Handshake | `initialize` | negotiates `agentCapabilities` |
| Token refresh | `_kiro/auth/getAccessToken` | Clay returns a host-refreshed KAS token |
| Create | `session/new` | returns `{ sessionId, modes, models }` |
| Resume | `session/load` | replays history |
| Model | `session/set_config_option` | `{ sessionId, configId: "model", value }` |
| Permissions | `session/set_config_option` | forces `autopilot: "off"` before prompting |
| Prompt | `session/prompt` | field is **`prompt`** (array of blocks); resolves with `{ stopReason }` |
| Stream | `session/update` | discriminated by `update.sessionUpdate` |
| Approve | `session/request_permission` | server→client request; reply `{ outcome: { outcome: "selected", optionId } }` |
| Abort | `session/cancel` | notification; in-flight prompt resolves `"cancelled"` |

## Files added

| File | Purpose |
|------|---------|
| `lib/yoke/kiro-acp-server.js` | Child-process JSON-RPC transport (binary lookup, send/notify/respond, auth-error detection) |
| `lib/yoke/adapters/kiro.js` | YOKE adapter: dynamic model catalog, session lifecycle, `session/update` event flattening, permission routing, resume, abort |
| `lib/kiro-defaults.js` | Single source of truth for Kiro defaults (agent/mode) |
| `lib/public/kiro-avatar.svg` | Branded avatar |
| `docs/guides/KIRO-INTEGRATION.md` | Full protocol reference + gotchas |

## Files changed (wiring — mirrors every `codex` touch-point)

- `lib/yoke/index.js` — factory switch, auth (`kiro-cli whoami`), install detection, `createAdapters`
- `lib/sdk-bridge.js` — `detectInstalledVendors`, login command, `KIRO` adapterOptions, neutral interrupt message
- `lib/sdk-message-processor.js`, `lib/project-notifications.js` — auth titles / login command
- `lib/project-sessions.js` — GUI-only session mode for kiro (no TUI adapter)
- Client UI: `index.html` (vendor toggle), `sidebar-sessions.js` / `sidebar-mobile.js` (new-session buttons, install-gated), `app-panels.js` (vendor button + effort levels), `app-rendering.js` / `app-messages.js` / `input.js` / `tools.js` / `mate-sidebar.js` / `sidebar-mates.js` (avatar & name maps)

## Key design decisions

- **Dynamic model catalog** (like Claude, unlike Codex's hardcoded list):
  `init()` runs `kiro-cli chat --list-models --format json` and filters out
  `[Internal]` / `[Deprecated]` entries. Default is the `auto` router model.
- **Permission name recovery**: the `session/request_permission` payload only
  carries `{ toolCallId, title }`, so the adapter caches `kind` + `rawInput`
  from the preceding `tool_call` notification and passes the canonical tool
  name (`Bash`, `Edit`, ...) to `canUseTool`. Without this, Clay's permission
  whitelist matching would break.
- **GUI-only**: kiro sessions always run in GUI mode, same as Codex.
- **Per-project adapter**: the ACP process is scoped to a project cwd/slug.
- **v3 engine by default**: Clay spawns
  `kiro-cli acp --agent-engine v3`; `CLAY_KIRO_AGENT_ENGINE` can override it.
- **Kiro-native MCP configuration**: Kiro reads
  `~/.kiro/settings/mcp.json`; Clay-managed MCP servers are not forwarded yet.
- **OS-isolation guard**: Kiro is hidden and rejected for OS-isolated Linux
  users until the ACP process supports per-user spawning.

## Verified end-to-end (against CLI 2.18.1, v3 engine / KAS 0.38.7)

- Init discovers 15 curated models; default `auto`
- Text streams in real time; `result` emitted with usage
- Model selection works (`session/set_config_option`)
- Bash tool shows approval with canonical name `Bash` + `{command}`; approve/deny routes through `canUseTool`
- Abort interrupts the turn cleanly
- Registers alongside claude/codex in the daemon adapter path
- Host-mediated token refresh, supervised tool execution, image prompts,
  session resume, cancel recovery, and two concurrent Kiro sessions

## Known gaps

- The public "CLI 3.0" release is not yet offered by the local updater; live
  verification used the shipping 2.18.1 binary's v3 engine.
- Validated via adapter/daemon-path harnesses, not a live browser session (the
  browser test is currently waiting for a Clay login). The WebSocket UI paths
  are wired but not yet fully exercised in a browser.
