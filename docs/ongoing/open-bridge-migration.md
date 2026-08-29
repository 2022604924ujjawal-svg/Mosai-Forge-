# Handoff: migrate `lib/yoke` → the `open-bridge` package

**Status:** proposed / not started
**Author:** handoff from the clayOS side (Chad + Claude), 2026-07-02
**Scope:** clay repo only. The open-bridge side is done.

---

## TL;DR

`open-bridge` (repo: `github.com/chadbyte/open-bridge`, currently at
`~/clayOS/open-bridge`, v0.2.0) is now the **single source of truth** for
the Claude/Codex bridge. It was rebuilt from this repo's latest
`lib/yoke` and made **host-independent** via a dependency-injection seam.
clayOS already consumes it standalone.

This doc is the plan for the second half of the vision: **clay stops
carrying its own `lib/yoke` fork and consumes `open-bridge` too**,
injecting its OS-level services instead of open-bridge hard-requiring
them.

Do **not** re-fork or blind-copy in either direction. The whole point is
one package, two consumers.

---

## Why this is now possible

`lib/yoke` used to reach *up* into clay-internal modules:

```
lib/yoke/adapters/claude.js  → require("../../os-users")        (2 calls)
                             → require("../../build-user-env")  (1 call)
lib/yoke/adapters/codex.js   → require("../../config").REAL_HOME (2 calls)
                             → require("../../mcp-local")        (1 call)
```

open-bridge replaced all six sites with calls to a single injection seam,
`open-bridge/host-integration.js`. It ships **no-op defaults** (no OS-user
isolation, `os.homedir()`, current env, no local MCP) so a standalone
consumer works with zero setup. A host reaches *down* by calling
`setHostIntegration()` once at boot.

So the coupling that made clay's `lib/yoke` un-extractable is gone — it's
now an injection contract clay can satisfy.

## The injection contract (what clay must provide)

open-bridge exposes `setHostIntegration(hooks)`. All hooks optional; any
omitted keeps its standalone default. open-bridge deliberately knows
**nothing** about OS users — all isolation logic lives inside clay's
`spawnWorker`, which receives a neutral launch spec and returns a
ChildProcess.

| open-bridge hook | what clay implements |
|---|---|
| `spawnWorker({command,args,cwd,stdio,context})` | resolve `context.worker` → OS user, build isolated env, drop privileges, spawn, return the ChildProcess |
| `realHome()` | `() => require("./config").REAL_HOME` (config exports the value; wrap in a fn) |
| `readMergedMcpServers()` | `() => require("./mcp-local").readMergedServers()` (same shape → `{name:{command,args,env}}`) |

The three former OS-user hooks (`resolveOsUserInfo`, `buildUserEnv`,
`wrapSpawnAsUser`) are **collapsed into that single `spawnWorker`**. They
stay as clay-internal functions (`os-users.js`, `build-user-env.js`) —
clay just calls them *inside* its own `spawnWorker`, where they belong.
open-bridge never sees a uid/gid/username; `context.worker` carries the
caller's opaque token (from `adapterOptions.CLAUDE.linuxUser`).

## Migration steps

1. **Add the dependency.** In clay's `package.json`, add
   `"@open-bridge/core": "^1.0.0"` (or `file:../open-bridge` / a git dep during
   development — clayOS uses a `file:` link). Because clay is a multi-user
   host, install with `install-links=true` if you hit the arborist
   "Invalid Version" dedupe bug on `file:` deps (see clayOS `.npmrc`).

2. **Inject at boot, once, before any adapter is created.** Earliest
   safe place is daemon startup (`lib/daemon.js`) before it first touches
   the bridge:

   ```js
   const { spawn } = require("child_process");
   const openBridge = require("@open-bridge/core");
   const osUsers = require("./os-users");
   const { buildUserEnv } = require("./build-user-env");

   openBridge.setHostIntegration({
     // All OS-user isolation lives HERE, inside clay's hook. open-bridge
     // just handed us a neutral spec + the opaque worker token.
     spawnWorker: (spec) => {
       const info = osUsers.resolveOsUserInfo(spec.context && spec.context.worker);
       const env  = buildUserEnv({ uid: info.uid, gid: info.gid, home: info.home,
                                   user: spec.context.worker, shell: info.shell || "/bin/bash" });
       const w = osUsers.wrapSpawnAsUser(spec.command, spec.args, {
         uid: info.uid, gid: info.gid, env, cwd: spec.cwd, stdio: spec.stdio,
       });
       return spawn(w.command, w.args, w.options);
     },
     realHome:             () => require("./config").REAL_HOME,
     readMergedMcpServers: () => require("./mcp-local").readMergedServers(),
   });
   ```

3. **Repoint the consumers.** Four files require `./yoke` today:
   - `lib/project.js:90` — `var yoke = require("./yoke")`
   - `lib/sdk-bridge.js:129, :1072` — `var yoke = require("./yoke")`
   - `lib/sdk-bridge.js:1501` — `require("./yoke/codex-app-server").findCodexPath()`
   - `lib/sdk-worker.js` — already a deprecated shim pointing at
     `lib/yoke/adapters/claude-worker.js`

   Change each `require("./yoke")` → `require("@open-bridge/core")` and
   `require("./yoke/codex-app-server")` → open-bridge exposes the same
   (it re-exports `findCodexPath` via the codex adapter path; confirm the
   exact export name and add one if missing). The public API
   (`createAdapter`, `createAdapters`, `checkAuth`, `checkInstalled`,
   `invalidateAuthCache`) is identical.

4. **Delete `lib/yoke/`** once nothing imports it. This is the moment the
   fork stops drifting.

5. **Keep clay's internal modules** (`os-users`, `build-user-env`,
   `config`, `mcp-local`) — they don't move; they're now *injected* into
   open-bridge rather than required by it.

## Verification (do not skip the multi-user path)

The standalone path is already proven in clayOS. clay's risk is the
**OS-user isolation** path, which only clay exercises:

- [ ] A normal (non-isolated) turn: claude + codex both stream.
- [ ] An isolated turn with `adapterOptions.CLAUDE.linuxUser` set: the
      worker still spawns as that Linux user (this now runs entirely
      inside clay's injected `spawnWorker`; if it wasn't injected, the
      default spawns as the current user with no isolation — a silent
      security downgrade, so assert the hook is wired at boot).
- [ ] `REAL_HOME` correctness when the daemon runs as root on behalf of a
      login user (codex skill discovery reads `<REAL_HOME>/.claude/skills`).
- [ ] Local MCP servers from `~/.clay/mcp.json` still injected into codex.
- [ ] `checkAuth()` / login-required detection unchanged.

If the isolated path breaks, it's almost certainly a missing or
mis-wired hook in step 2 — the defaults silently no-op isolation.

## What changed on the open-bridge side (reference)

- New `host-integration.js` (the seam + defaults + `setHostIntegration`).
- All six `../../` requires in the adapters replaced with
  `getHostIntegration()` calls.
- `index.js` exports `setHostIntegration` / `getHostIntegration` /
  `resetHostIntegration`.
- Adapters/core were refreshed from this repo's latest `lib/yoke`, so
  open-bridge is current as of 2026-07-02 (includes the codex binary
  bin/-layout fix and the 401 auth-signal detection).
- `codex-app-server.js` is byte-identical to `lib/yoke/codex-app-server.js`.

## Do NOT

- Re-copy `lib/yoke` → open-bridge (or vice versa). Sync is now
  *unnecessary*: after this migration there is one source. Before it,
  open-bridge is already ahead/equal.
- Re-introduce `require("../../…")` inside open-bridge. Anything a host
  needs goes through `setHostIntegration`.
- Ship clay-internal modules into the open-bridge package.
