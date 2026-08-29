# Handoff: bring the Kiro adapter to Kiro CLI 3.x and merge-readiness

**Status:** in progress / blocked on live 3.x verification
**Author:** handoff from Chad + Claude, 2026-08-15
**Branch:** `feat/kiro-acp`
**Scope:** clay repo only. Everything you need is in this document; do not
assume any context outside it.

---

## Mission

The Kiro CLI integration (ACP adapter) was built and verified against
**kiro-cli 2.7.0**. Kiro has since shipped **CLI 3.0** with breaking changes,
and the official ACP documentation now differs from what the code implements.
Your job is to:

1. Commit the uncommitted work that is sitting in the working tree (step 0).
2. Fix a known init-failure recovery bug that permanently poisons the adapter
   (phase 2 — you can do this before or in parallel with phase 1).
3. Re-verify the entire ACP protocol surface against a real kiro-cli 3.x
   binary and adapt the code where 3.x diverges (phase 1).
4. Close the remaining integration gaps (MCP wiring, OS-user isolation
   decision, docs, CI) (phases 3-5).
5. Prove it end-to-end in a live browser session (phase 4).

Estimated overall completeness today: ~60%. The wiring is done and unit
tests pass; live 3.x behavior is unverified and several known bugs/gaps
remain.

### References you must read first

- Kiro ACP protocol docs: https://kiro.dev/docs/cli/acp/
- Kiro CLI 3.0 changes: https://kiro.dev/docs/cli/v3/
- In-repo protocol reference (2.7.0-era, to be updated by you):
  `docs/guides/KIRO-INTEGRATION.md`
- Integration summary (partially stale, to be updated by you):
  `docs/guides/KIRO-INTEGRATION-SUMMARY.en.md`
- Repo conventions: root `CLAUDE.md`. Highlights that apply here: `var` only,
  no arrow functions, CommonJS on the server side, English-only comments and
  commit messages, Angular commit convention, modules under 500 lines,
  read `docs/guides/MODULE_MAP.md` before adding files.
- `docs/ongoing/open-bridge-migration.md`: a separate, **not-started** plan to
  replace `lib/yoke` with the external `open-bridge` package. Do NOT start
  that migration as part of this work, but keep it in mind: every fix you
  make in `lib/yoke` will eventually need to land in open-bridge too, so keep
  changes self-contained inside the yoke layer where possible.

---

## Architecture map (current, as implemented)

```
Clay session (vendor=kiro, always GUI mode)
    |
    v
lib/sdk-bridge.js            createQuery plumbing, canUseTool routing,
    |                        vendor detection, lazy adapter init
    v
lib/yoke/index.js            adapter registry: createAdapter switch (":54"),
    |                        auth check via `kiro-cli whoami` (":199-209"),
    |                        install detection (":232-247")
    v
lib/yoke/adapters/kiro.js    YOKE adapter (1040 lines):
    |                          - init / model catalog / capabilities
    |                          - createKiroQueryHandle: session lifecycle,
    |                            event flattening, permission routing, abort
    v
lib/yoke/kiro-acp-server.js  child-process transport (308 lines):
    |                          - spawn `kiro-cli acp`
    |                          - line-delimited JSON-RPC 2.0 over stdio
    |                          - per-session handler routing (addHandler/
    |                            removeHandler, _handleMessage)
    |                          - stderr auth-error detection
    v
kiro-cli binary              looked up by findKiroPath():
                               KIRO_CLI_PATH env > ~/.local/bin/kiro-cli >
                               ~/bin > /usr/local/bin > /opt/homebrew/bin >
                               `which kiro-cli`
```

Supporting files:

| File | Role |
|---|---|
| `lib/kiro-defaults.js` | Single source of truth for Kiro defaults. Currently only `mode: "kiro_default"`. |
| `lib/sdk-bridge.js:1298,1353-1356` | Builds `adapterOptions.KIRO = { mode, mcpServers: [] }` per query. |
| `lib/sdk-bridge.js:1513-1518` | `detectInstalledVendors`: pushes `"kiro"` when `findKiroPath()` resolves or `which kiro-cli` succeeds. In multi-user mode the lookup runs as the target Linux user via `su - <user> -c "which kiro-cli"` (`:1489-1501`). |
| `lib/sdk-bridge.js:155` | Login command string: `"kiro-cli login"`. |
| `lib/sdk-message-processor.js:55-58` | Auth-required message titles / login command per vendor. |
| `lib/sdk-message-processor.js:159-165` | Adopts `parsed.sessionId` from the `result` event into `session.cliSessionId` — this is how resume works. |
| `lib/project-sessions.js:427-434` | Forces `mode: "gui"` for kiro sessions (no TUI adapter). |
| `lib/project-notifications.js:24` | Push-notification title for kiro auth failures. |
| `test/kiro-acp-routing.test.js` | 14 unit tests for the sessionId routing layer (see below). |
| Client UI | `index.html` (vendor button), `sidebar-sessions.js` / `sidebar-mobile.js` (new-session picker), `app-panels.js`, `app-rendering.js` (avatar/name maps), `lib/public/kiro-avatar.svg`. The sidebar picker work was committed separately (`5a1b34a`); the vendor is fully selectable in the UI. |

### The data flow of one turn (as implemented for 2.7.0)

1. `sdk-bridge.js` calls `adapter.createQuery(queryOpts)` with
   `canUseTool`, `systemPrompt`, `resumeSessionId` (= `session.cliSessionId`),
   `adapterOptions.KIRO`.
2. `createKiroQueryHandle` (`kiro.js:336`) registers a handler on the shared
   ACP process (`acp.addHandler`, `kiro.js:569`), then:
   - resume: `session/load { sessionId, cwd, mcpServers }` with fresh-session
     fallback on error (`kiro.js:572-585`), or
   - new: `session/new { cwd, mcpServers }` -> `{ sessionId }` (`kiro.js:586-592`).
   - `handlerEntry.sessionId` is bound before `session/load` is sent so
     replayed events route correctly (`kiro.js:574`).
3. Best-effort `session/set_model` / `session/set_mode` (`kiro.js:596-601`).
4. Turn loop: `session/prompt { sessionId, prompt: [blocks] }` with a
   **30-minute** timeout (`kiro.js:613-616`). While it is pending, the child
   streams `session/update` notifications and may send
   `session/request_permission` requests.
5. `session/update` payloads are flattened into YOKE events by
   `flattenUpdate` (`kiro.js:145-266`); tool output is accumulated across
   split `tool_call_update` events (`accumulateToolContent` /
   `finalToolContent`, `kiro.js:316-332`).
6. Permission requests are answered via `canUseTool`; the payload only
   carries `{ toolCallId, title }`, so canonical tool name + input are
   recovered from the `tool_call` cache in `state.toolMeta`
   (`kiro.js:438-475`). **Fail-closed**: no `canUseTool` -> deny
   (`kiro.js:467-473`).
7. The turn ends when the `session/prompt` request resolves with
   `{ stopReason }`; the adapter emits the YOKE `result` event carrying
   `sessionId` (`kiro.js:517-538`), which sdk-message-processor adopts into
   `session.cliSessionId`.
8. Abort = `session/cancel` notification + immediate iterator end
   (`kiro.js:701-710`).
9. The per-query handler is removed in a `finally` (`kiro.js:640-644`).

### Transport-level routing invariants (already unit-tested)

One ACP child process is shared by every session in a project, so
`KiroAcpServer._handleMessage` (`kiro-acp-server.js:139-198`) routes
server-initiated messages by `params.sessionId`:

- A message with a sessionId goes only to handlers bound to that sessionId.
- A message without a sessionId (auth failures via the synthetic
  `_kiro/error`) fans out to every handler.
- A server->client **request** (has an id) is delivered to exactly one
  handler; if no handler matches, it is answered with a JSON-RPC error
  (`-32001`) instead of being dropped — a dropped request would block
  kiro-cli until the 30-minute prompt timeout.
- A throwing handler still produces an error response (`-32000`).
- `test/kiro-acp-routing.test.js` covers all of this (14 tests). Keep these
  green; extend them if you touch `_handleMessage`.

---

## Step 0: commit the work already in the tree

The working tree currently holds finished, reviewed work that predates this
handoff. **Commit it first** so you start from a clean tree. Current state:

```
 M lib/daemon.js              <- idle reaper generalized (uncommitted hunk)
 M lib/project.js             <- adapter shutdown generalized (uncommitted hunk)
 M lib/yoke/adapters/kiro.js  <- routing + fail-closed permissions + fs caps
 M lib/yoke/index.js          <- shared-adapter marker
 M lib/yoke/kiro-acp-server.js<- per-session handler routing
 M package.json               <- adds "test" script
?? docs/ongoing/open-bridge-migration.md   <- separate plan, commit as docs
?? test/kiro-acp-routing.test.js           <- the 14 routing tests
?? docs/ongoing/kiro-cli3-handoff.md       <- this document
```

What each uncommitted change is (verify with `git diff` before committing):

1. **`lib/yoke/kiro-acp-server.js`** — replaces the single `eventHandler`
   slot with a `handlers` array routed by sessionId (`addHandler` /
   `removeHandler` / rewritten `_handleMessage`). Fixes the original bug
   where a second concurrent query overwrote the first query's handler and
   silently dropped its permission requests. Also: unanswered requests now
   get JSON-RPC error replies; the auth-dedupe timer is `unref()`ed.
2. **`lib/yoke/adapters/kiro.js`** — companion changes: uses
   `addHandler`/`removeHandler` with a `finally` teardown; binds
   `handlerEntry.sessionId` before `session/load`; **fail-closed** permission
   default (deny when no `canUseTool`); stops advertising
   `fs.readTextFile/writeTextFile` client capabilities we have no handler for
   (kiro-cli would send `fs/read_text_file` and block forever).
3. **`lib/yoke/index.js`** — marks the shared Claude adapter instance with
   `.shared = true` so per-project teardown never shuts it down.
4. **`lib/project.js` (unstaged hunk)** — generalizes project-destroy
   shutdown from codex-only to every adapter with a `shutdown()` function,
   skipping `.shared` ones.
5. **`lib/daemon.js` (unstaged hunk)** — generalizes the idle reaper from
   `adapters.codex` only to every adapter exposing `shutdownIfIdle(ms)`.
   Adds `CLAY_ADAPTER_IDLE_MS` / `CLAY_ADAPTER_REAPER_MS` env names with the
   old `CLAY_CODEX_*` names kept as fallback aliases.
6. **`package.json`** — adds `"test": "node --test --test-force-exit
   test/*.test.js"`.
7. **`test/kiro-acp-routing.test.js`** — the routing tests described above.

Suggested split (follow the `angular-commit` skill; never add Co-Authored-By):

- `fix(yoke): route Kiro ACP events per session and fail closed on permissions`
  -> items 1, 2, 7
- `refactor(yoke): generalize adapter shutdown and idle reclaim across vendors`
  -> items 3, 4, 5
- `test: add npm test script running node:test suites` -> item 6
  (or fold into the first commit)
- `docs: add open-bridge migration and kiro 3.x handoff plans` -> the two
  docs/ongoing files

Run `npm test` (should be 37/37: 14 kiro routing + 23 security) and the two
syntax sweeps before each commit:

```sh
npm test
find bin lib -name '*.js' -not -path 'lib/public/*' -exec node --check {} +
for f in $(find lib/public -name '*.js'); do node --check --input-type=module < "$f" || echo "FAIL $f"; done
```

---

## Phase 1: verify and adapt to Kiro CLI 3.x  (the core of this handoff)

Everything protocol-shaped in the adapter was verified against **2.7.0** by
driving the real binary. The official docs now describe things differently
(e.g. the docs' notification/prompt content examples do not match the
`session/update` / `prompt` field shapes in the code). Documentation and
shipping binaries frequently disagree, so **the binary is the source of
truth — trace it, do not code from the docs alone.**

### 1a. Environment

This machine does not have kiro-cli installed (`which kiro-cli` and
`which kiro` both fail; `~/.local/bin` only has `claude`). Install the
current CLI 3.x per https://kiro.dev/docs/cli/ (or ask Chad to install /
provide credentials). Then:

```sh
kiro-cli --version         # or `kiro --version` — see binary-name note below
kiro-cli login             # authenticate (interactive)
kiro-cli whoami            # must exit 0 when logged in
```

If the binary lands somewhere `findKiroPath()` does not look, export
`KIRO_CLI_PATH=/path/to/binary` — it is the first thing checked
(`kiro-acp-server.js:20-22`).

**Binary name check:** v3 may have renamed or aliased the binary
(`kiro` vs `kiro-cli`). `findKiroPath()` hardcodes `kiro-cli`
(`kiro-acp-server.js:24`), the auth checker runs `kiro-cli whoami`
(`yoke/index.js:203`), install detection greps for `kiro-cli`
(`sdk-bridge.js:1518`), and user-facing login hints say `kiro-cli login`
(`sdk-bridge.js:155`, `sdk-message-processor.js:58`). If the name changed,
update all of them and keep the old name as a fallback candidate.

### 1b. Raw protocol trace

Drive the binary directly and capture a full transcript. Keep stdin open;
one JSON-RPC message per line:

```sh
# Terminal 1 — run the agent with a fifo so you can type frames in slowly
mkfifo /tmp/acp-in
kiro-cli acp < /tmp/acp-in | tee /tmp/acp-out.jsonl

# Terminal 2 — feed frames one at a time
exec 3>/tmp/acp-in
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"clay","version":"1.0.0"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}' >&3
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}' >&3
printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<SID>","prompt":[{"type":"text","text":"run: echo hello"}]}}' >&3
# ... answer any session/request_permission that arrives, try session/cancel, etc.
```

Also check whether `kiro-cli acp` itself grew new flags in 3.x
(`kiro-cli acp --help`); the spawn site is `kiro-acp-server.js:75-89`
(args are just `["acp"]` plus optional `opts.extraArgs`).

### 1c. Protocol touchpoint checklist

For each row: confirm against the live 3.x trace; adapt code + tests + the
`KIRO-INTEGRATION.md` reference if it changed. This table is the complete
list of places where the code encodes 2.7.0 protocol assumptions.

| # | Assumption (2.7.0) | Code location | What to check in 3.x |
|---|---|---|---|
| 1 | `initialize { protocolVersion: 1, clientInfo, clientCapabilities.fs }` | `kiro.js:888-897` | Protocol version number; whether fs capability flags are still shaped this way; new required capabilities. |
| 2 | `session/new { cwd, mcpServers } -> { sessionId, modes, models }` | `kiro.js:586-592` | Param names, result shape, whether `mcpServers` entries changed shape. |
| 3 | `session/load { sessionId, cwd, mcpServers }` replays history then resolves | `kiro.js:575-585` | Does it still exist? Does it still replay `session/update` events (the adapter binds sessionId before sending for exactly this reason)? Fallback on unknown session still an error response? |
| 4 | `session/set_model { sessionId, modelId }` | `kiro.js:596-598, 682-688` | Method name and param names. |
| 5 | `session/set_mode { sessionId, modeId }` | `kiro.js:599-601` | v3 reworked agents; `"kiro_default"` (`lib/kiro-defaults.js:8`) may no longer be a valid mode id. Enumerate valid modes from `session/new`'s `modes` result and update the default. |
| 6 | `session/prompt { sessionId, prompt: [{type:"text",text}] }` resolves with `{ stopReason }` at turn end | `kiro.js:613-625` | **Docs now show different content shapes — verify field name (`prompt` vs `content`), block shape, and image block shape (`{type:"image",data,mimeType}` from `kiro.js:667`).** Confirm `stopReason` values (`"end_turn"`, `"cancelled"`, others?). |
| 7 | Streaming via `session/update` notifications discriminated by `update.sessionUpdate` | `kiro.js:478-483, 145-266` | **Docs reportedly show `session/notification` now.** If the method name changed, `handleServerEvent` (`kiro.js:478`) and the routing tests' fixtures need updating. Check every discriminator: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`. Check the content envelope (`update.content.text`). |
| 8 | Tool output split across `tool_call_update` events: interim `content`, then `status:"completed"` with output in `rawOutput.items[].Json.{stdout,stderr}` | `kiro.js:216-240, 291-332` | This was reverse-engineered from 2.7.0 behavior. Re-trace a Bash tool call end-to-end and confirm the accumulate+fallback logic still produces non-empty `tool_result` content. |
| 9 | `session/request_permission` payload carries only `{ toolCallId, title }`; kind/rawInput recovered from cached `tool_call` | `kiro.js:438-475, 186-189` | Check whether 3.x now includes `kind`/`rawInput` in the request (the code already prefers `tc.kind`/`tc.rawInput` when present, cache is the fallback). Check option kinds (`allow_once`, `allow_always`, `reject_once`, `reject_always`). |
| 10 | Permission response: doubly-nested `{ outcome: { outcome: "selected", optionId } }`, and `{ outcome: { outcome: "cancelled" } }` | `kiro.js:452, 462, 465, 472` | Confirm shape unchanged. |
| 11 | `session/cancel` is a notification; in-flight prompt resolves with stopReason `"cancelled"` | `kiro.js:704-708` | Confirm; also confirm cancelling is still per-session. |
| 12 | Model catalog: `kiro-cli chat --list-models --format json` -> `{ models: [{model_id, description}], default_model }`; filter `[Internal]`/`[Deprecated]` | `kiro.js:116-140` | v3 may have changed the subcommand, flags, or JSON field names. Also update the hardcoded fallback list (`kiro.js:902-904`: `auto`, `claude-sonnet-4.5`, `claude-opus-4.5`) to the actual 3.x lineup. |
| 13 | Auth: `kiro-cli whoami` exits 0 when logged in; login is `kiro-cli login`; stderr auth regexes | `yoke/index.js:196-209`, `kiro-acp-server.js:215-227`, `sdk-bridge.js:155` | Confirm whoami semantics; capture what 3.x actually prints on 401/expired-token and adjust the regex if needed. |
| 14 | `_kiro.dev/*` notifications are informational and ignored | `kiro.js:495-497` | Check whether 3.x sends new server->client **requests** (they would hit the no-handler error path or the first handler; anything that must be answered needs explicit handling). |
| 15 | fs capabilities declined (`readTextFile:false, writeTextFile:false`) | `kiro.js:896` | Confirm kiro 3.x respects declined caps and uses its own tools instead. If it *requires* fs caps, implementing them needs cwd confinement AND routing through `canUseTool` — see the comment at `kiro.js:891-895`. Do not enable them casually. |
| 16 | Timeouts: initialize 30s, session/new + session/load 60s, set_model/set_mode 15s, prompt 30min | `kiro.js:575-616` | Sanity-check against 3.x behavior (e.g. session/load on a long history). |

### 1d. Update the protocol docs

When the trace is done, update `docs/guides/KIRO-INTEGRATION.md` (change the
"verified against kiro-cli 2.7.0" headers to the actual 3.x version and fix
every changed shape) and `KIRO-INTEGRATION-SUMMARY.en.md`. Known stale
item already: `KIRO-INTEGRATION-SUMMARY.en.md:79-83` lists "Bash tool_result
content came through empty" as a known gap — that was fixed in commit
`fb1d8b2` (the accumulate/rawOutput logic); delete or rewrite that bullet.

---

## Phase 2: fix the init-failure recovery bug  (do this regardless of 3.x)

**Location:** `createKiroAdapter` in `lib/yoke/adapters/kiro.js:863-917`.

`adapter.init()` memoizes its in-flight promise:

```js
if (_acp && _acp.started && _cachedModels.length > 0) {   // :867 fast path
  return Promise.resolve(buildReadyResponse([]));
}
if (_initPromise) return _initPromise;                    // :870
_initPromise = (async function() {
  ...spawn + initialize...
  _initPromise = null;                                    // :911 success only
  return buildReadyResponse(skillNames);
})();
return _initPromise;
```

Only the success path clears `_initPromise`. Two concrete failure modes:

1. **Permanent poisoning.** If the async body rejects (binary missing,
   `initialize` timeout, auth failure), `_initPromise` stays pointing at the
   rejected promise forever. Every subsequent `init()` — including the auth
   recovery path in `sdk-bridge.js:1115-1124` that re-runs
   `ensureVendorReady` after the user logs in — returns the same stale
   rejection. Worse, the idle reaper cannot clean it up either:
   `shutdownIfIdle` returns `false` whenever `_initPromise` is truthy
   (`kiro.js:1024`). The only ways out are project destroy or daemon
   restart. So: user sees "not logged in", runs `kiro-cli login`, retries,
   and still gets the old error indefinitely.

2. **Half-initialized fast path.** `_acp.started` is set to `true` when the
   child process spawns (`kiro-acp-server.js:131`), *before* the
   `initialize` handshake. The model catalog fetch (`kiro.js:879`) happens
   before the spawn and can succeed independently. So if spawn succeeds and
   `initialize` fails (timeout/reject) while the process stays alive, a
   later `init()` hits the `:867` fast path (`_acp && _acp.started &&
   _cachedModels.length > 0`) and returns "ready" for an ACP process that
   never completed its handshake. `createQuery` then drives an
   un-initialized agent. Additionally the failed child is never killed —
   a process leak.

**Required fix shape** (adapt naming to the file's style):

- Attach a `.catch` to the init IIFE that:
  - clears `_initPromise` **only if it still points at this attempt**
    (capture the promise in a local and compare, so you never clobber a
    newer retry), and mirrors the same guard on the success path;
  - tears down the failed `_acp` (use the existing `stopAcp()` helper,
    `kiro.js:816-826`, which SIGTERMs then SIGKILLs) and nulls `_acp`;
  - re-throws so the current caller still sees the failure.
- Introduce an explicit `_initialized` flag set to `true` only after the
  `initialize` response resolves, and change the `:867` fast path to require
  it instead of trusting `_acp.started`.
- Keep `_cachedModels` across failures (the catalog fetch is independent and
  caching it is harmless).
- Mind the interaction with `beginShutdown` (`kiro.js:828-858`), which
  already races `_initPromise` with a 5s deadline — your catch handler must
  not double-stop a process that shutdown is stopping (nulling `_acp` before
  the async stop completes is the existing pattern; follow it).

**Add unit tests** in a new `test/kiro-adapter-init.test.js`:

- init failure -> second `init()` actually re-attempts (not the same
  rejection object);
- init failure -> the spawned child received a kill (stub `KiroAcpServer`);
- half-init state -> fast path does NOT report ready;
- `shutdownIfIdle` can reclaim after a failed init (i.e. `_initPromise` no
  longer blocks it).

You can inject stubs the same way `test/kiro-acp-routing.test.js` does
(construct objects directly, override `_write`/`proc`). If constructor-level
injection is too awkward, it is acceptable to add a small test seam to
`createKiroAdapter` (e.g. an optional `opts._AcpServerCtor`) — keep it
underscore-prefixed and documented.

---

## Phase 3: close the integration gaps

### 3a. MCP servers (decide, then implement or document)

Clay merges MCP server configs and passes them to Claude/Codex, but the Kiro
path hardcodes an empty list: `lib/sdk-bridge.js:1353-1356` sets
`adapterOptions.KIRO = { mode, mcpServers: [] }`, which flows to
`session/new`/`session/load` (`kiro.js:956, 578, 589`). Meanwhile kiro-cli
reads its own `~/.kiro/settings/mcp.json` natively.

Decide one of:

- **Option A (recommended first step): rely on Kiro-native MCP config.**
  Leave `[]`, document in `KIRO-INTEGRATION.md` that Kiro sessions use
  `~/.kiro/settings/mcp.json` and Clay-managed MCP servers do not apply to
  the kiro vendor. Cheap, honest, no double-registration risk.
- **Option B: map Clay's merged MCP list into ACP `mcpServers` entries.**
  Requires mapping `mergedMcpServers` (see how `queryOpts.toolServers` /
  `extractMcpDescriptors` are built around `sdk-bridge.js:1326-1327`) into
  whatever entry shape 3.x expects (verify in the 1b trace — likely
  `{ name, command, args, env }` for stdio). Must dedupe against Kiro-native
  config to avoid registering the same server twice, and must skip
  Clay-internal MCP servers that only make sense in-process. Only do this
  after phase 1 confirms the 3.x shape.

### 3b. OS-user isolation (multi-user deployments)

`KiroAcpServer` spawns the child directly (`kiro-acp-server.js:85-89`) as
the daemon's own user. There is no `linuxUser` handling, unlike the Claude
worker path. But `detectInstalledVendors` checks installation **per Linux
user** via `su` (`sdk-bridge.js:1489-1501`), so in OS-isolation mode the UI
can offer Kiro to a user whose session would then run with the **daemon
user's** binary, home, and Kiro credentials — a cross-user credential leak.

Minimum acceptable fix for this handoff: in `sdk-bridge.js` (or
`yoke/index.js createAdapters`), refuse/hide the kiro vendor when
`linuxUser` isolation is active, with a clear log line. Full per-user
spawning (the way `claude-worker` does it) is a follow-up and should be
noted in `docs/guides/KIRO-INTEGRATION.md` as a known limitation either way.

### 3c. CI

`.github/workflows/pr-checks.yml` deliberately never runs `npm install`
(fork PRs run with no secrets; install scripts of a fork's dependency tree
must never execute — read the comment block at the top of that file before
touching it). It only runs `node --check` sweeps and
`scripts/check-client-imports.js`. So `npm test` is NOT run in CI at all.

Add tests to CI without violating that policy. Recommended: a separate
job/workflow that runs `npm ci --ignore-scripts && npm test`.
`--ignore-scripts` prevents fork-controlled install-script execution; verify
the test suite still passes without lifecycle scripts (the tests require
`lib/server.js` -> real deps from `package-lock.json`; if some native dep
needs its install script, either exclude it via test refactoring or restrict
the test job to `push: branches: [main]` where the code is already trusted).
Keep the existing checks job untouched.

### 3d. Docs refresh

Covered in 1d; additionally add kiro rows to `docs/guides/MODULE_MAP.md` if
missing.

---

## Phase 4: end-to-end verification matrix

Unit tests only cover transport routing. The following must be exercised
against the real 3.x binary — first via the adapter directly, then in a
live browser.

Dev server: `npm run dev` from the repo root (this is
`node bin/cli.js --dev`); it serves HTTPS on the dev ports (currently 2635
in this checkout). A production daemon from the globally installed
`clay-server` may also be running on 2633 — do not confuse them. Server-side
file changes need a daemon restart; client files are served `no-cache`.

Checklist (all in a session with `vendor=kiro`):

- [ ] Fresh session: `session/new`, text streams live
      (`text_start`/`text_delta` in the UI), turn completes, `result` shows
      usage and the context bar updates (`usage_update` handling,
      `kiro.js:257-261`).
- [ ] Thinking stream renders (`agent_thought_chunk` -> thinking block).
- [ ] Bash tool: approval dialog shows canonical name `Bash` with the real
      command as input; Approve runs it; the tool result bubble is
      **non-empty** (this exercises the split tool_call_update accumulation).
- [ ] Deny path: rejecting the permission actually blocks the tool.
- [ ] Auto-approval: a whitelisted tool pattern skips the dialog
      (this is why `state.toolMeta` recovery matters).
- [ ] Two kiro sessions in the same project running concurrently: each
      session's permission requests appear in the right session; aborting
      one does not disturb the other (the routing layer's reason to exist).
- [ ] Stop button mid-turn: turn interrupts, typing indicator clears, next
      message works.
- [ ] Multi-turn: second message in the same session reuses the sessionId
      (watch the `[yoke/kiro] createQuery: ... resume=` log).
- [ ] Resume after daemon restart: reopen the session, send a message,
      `session/load` replays and the turn works; unknown-session fallback
      (delete kiro's session state) degrades to a fresh session without an
      error surfaced to the user.
- [ ] Model picker: dynamic catalog appears, `session/set_model` applies,
      internal/deprecated entries filtered.
- [ ] Logged-out flow: `kiro-cli logout` (or expire credentials), send a
      message -> `auth_required` notification with the correct login
      command; log in; retry succeeds **without a daemon restart** (this is
      the phase 2 fix proving itself).
- [ ] Idle reclaim: leave the project idle past `CLAY_ADAPTER_IDLE_MS`
      (set it low for the test) and confirm
      `[yoke/kiro] Reclaimed idle adapter` fires and the next message
      re-initializes cleanly.
- [ ] Title generation: a new kiro session gets an auto title
      (`generateTitle`, `kiro.js:988-1013`, runs a toolless query).
- [ ] Images: paste an image into the composer and confirm the prompt block
      shape works in 3.x (`kiro.js:663-672`).

Record the results (pass/fail + notes) at the bottom of this file when done.

---

## Known constraints and gotchas for the implementing agent

- **kiro-cli is not installed on this machine.** Everything above that says
  "live" needs the binary installed and logged in first (phase 1a).
- The ACP child is **per project** (adapter instance per cwd/slug), shared
  by all of that project's sessions. Do not reintroduce any single-handler
  or per-process-global session assumptions.
- Timeout on `session/prompt` is 30 minutes; any server->client request that
  goes unanswered blocks kiro-cli until then. Every code path that receives
  a request with an `id` must answer it exactly once, even on error. The
  transport enforces this for unroutable/throwing cases; keep it that way.
- `handle.abort()` must remain synchronous-ish: notification + iterator end.
  sdk-bridge emits the user-facing "interrupted" message itself.
- Style: `var`, no arrow functions, CommonJS (`require`) in all of
  `lib/yoke`. English comments. Modules under 500 lines — `kiro.js` is at
  1040 and grandfathered; do not grow it substantially (if phase 1 forces
  large changes, split flattening/event code into
  `lib/yoke/kiro-events.js` or similar).
- Do not commit, push, or open PRs beyond what step 0 describes without
  explicit approval from Chad. Draft commit messages first if unsure.
- Do not start the open-bridge migration (`docs/ongoing/open-bridge-migration.md`)
  as part of this work.

## Acceptance criteria ("merge ready")

1. Step 0 commits landed; working tree clean.
2. Phase 2 init-recovery fix landed with unit tests.
3. Phase 1 table fully checked against a real 3.x binary; code and
   `docs/guides/KIRO-INTEGRATION*.md` updated; the docs no longer claim
   2.7.0 verification.
4. Phase 3a decision made and implemented/documented; 3b guard in place for
   OS-isolation mode; 3c tests running in CI within the no-fork-scripts
   policy.
5. Phase 4 matrix fully green against 3.x, with results recorded below.
6. `npm test` green; both syntax sweeps green; no new console errors in a
   normal kiro session.

---

## Verification log

### 2026-08-15 — static and live adapter verification

- Step 0 landed as `9bffa51`, `66fecfb`, `f08aae7`, and `60afc03`.
- Fixed poisoned/half-initialized init recovery; added retry, child cleanup,
  half-init, idle reclaim, v3 auth callback, and replay-suppression tests.
- The official updater reports Kiro CLI 2.18.1 as current. Live v3 verification
  therefore used `kiro-cli acp --agent-engine v3` (KAS 0.38.7).
- Confirmed live: initialize, host token callback, session/new, prompt field,
  session/update streaming, `vibe` mode, model config option, supervised
  permission approve/deny, non-empty Bash result, context usage, cancel and
  next-turn recovery, resume without replay duplication, images, title
  generation, and two concurrent sessions with correctly routed approvals.
- Kiro-native MCP configuration selected for now; Clay-managed MCP forwarding
  remains intentionally disabled and documented.
- OS-isolated users are blocked at adapter creation, lazy creation, vendor
  discovery, and query start until per-user ACP spawning exists.
- `npm ci --ignore-scripts && npm test` passed in a clean temporary copy.
- Browser E2E passed fresh Kiro session creation, dynamic model rendering,
  streaming text, non-empty Bash output, permission denial, mid-turn stop, and
  next-turn recovery. It also exposed and fixed a client race where a new
  Codex/Kiro session could retain the previous session's Claude vendor state.
- The browser was bootstrapped with an existing dev auth token rather than a
  manual PIN. Logged-out Kiro recovery was not exercised because it would alter
  the user's current Kiro credentials.
