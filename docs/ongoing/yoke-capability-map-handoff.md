# Handoff: YOKE vendor registry + descriptive capability map

**Status:** proposed / ready to implement
**Author:** handoff from Chad + Claude, 2026-08-15
**Branch:** start from `main` (v2.47.0-beta.2, Kiro integration merged via PR #385)
**Scope:** clay repo only. Everything you need is in this document.

---

## Mission

YOKE's control plane is too narrow: hosts cannot ask an adapter "what can
you do / what are you called / how do I log you in", so they ask by vendor
name instead. Today there are **16 server-side and ~10 client-side
vendor-string conditionals outside `lib/yoke`** (full inventory below).
Every one of them violates the project rule in `docs/guides/MODULE_MAP.md`
("do not add vendor-specific logic outside the adapter") and every new
vendor multiplies them.

Your job:

1. Add a **static vendor registry** inside `lib/yoke` (metadata available
   without initializing an adapter).
2. **Extend the dynamic capabilities map** each adapter returns from
   `init()` so it actually describes the adapter's method surface.
3. **Replace the inventoried conditionals** with registry/capability
   lookups, server side first, then the client sites in scope.
4. Add drift-prevention unit tests.

This is deliberately NOT the full "capability model v2" (no adapterOptions
teardown, no operation namespaces, no vendor-request channel rework). It is
the cheap, self-contained first slice that any future v2 needs regardless.

### Constraints

- Repo conventions (root `CLAUDE.md`): `var` only, no arrow functions,
  CommonJS on the server, English comments/commits, Angular commit
  convention, modules under 500 lines, no Co-Authored-By lines.
- Keep every change inside `lib/yoke` plus its consumers. Do not start the
  open-bridge migration (`docs/ongoing/open-bridge-migration.md`); this
  work must stay portable to open-bridge later, which means: no requires
  from `lib/yoke` up into clay internals beyond what already exists.
- Do not commit/push/PR without explicit approval from Chad.
- `npm test` (51+ tests) and the two syntax sweeps must stay green:

```sh
npm test
find bin lib -name '*.js' -not -path 'lib/public/*' -exec node --check {} +
for f in $(find lib/public -name '*.js'); do node --check --input-type=module < "$f" || echo "FAIL $f"; done
node scripts/check-client-imports.js
```

---

## Background: how capabilities flow today

- Each adapter's `init()` resolves with `buildReadyResponse()` containing a
  `capabilities` object (9 booleans + `toolPolicy`), e.g.
  `lib/yoke/adapters/claude.js:1182`, `codex.js:1144`, `kiro.js:870-880`.
- `lib/sdk-bridge.js:1596-1597` stores it into `sm.capabilitiesByVendor`.
- `lib/sessions.js:586` and `lib/project-connection.js:233` attach it to
  the `session_switched` message as `capabilities`.
- Client: `lib/public/modules/app-messages.js:637` stores it as
  `store.vendorCapabilities`.

**The critical limitation:** `capabilitiesByVendor[vendor]` exists only
AFTER that vendor's adapter has initialized, and non-default adapters are
lazy-initialized (see the comment at `lib/sdk-bridge.js:1575-1581`). But
most of the inventoried conditionals run BEFORE or WITHOUT init: session
creation, login-command construction, push-notification titles, install
detection. That is why this handoff introduces a **static registry**
separate from the dynamic `init()` capabilities. Do not try to serve
static metadata from `init()`; it will regress the lazy-init paths.

---

## Part 1: the static vendor registry

New file: `lib/yoke/vendor-registry.js` (CommonJS, well under 500 lines).
Single source of truth for per-vendor **static** facts. Suggested shape:

```js
// lib/yoke/vendor-registry.js
// Static, init-free facts about each vendor YOKE supports. Anything that a
// host needs BEFORE an adapter is initialized belongs here; anything that
// depends on a live adapter (models, effort levels) stays in init()'s
// capabilities. Do not import adapters from this file.

var VENDOR_REGISTRY = {
  claude: {
    displayName: "Claude Code",
    loginCommand: "claude login",
    binaryName: "claude",
    avatar: "/claude-code-avatar.png",
    // Which session modes exist for this vendor. "tui" only for vendors
    // with a real terminal adapter (claude --session-id / --resume).
    sessionModes: ["gui", "tui"],
    // Whether the runtime can be spawned as an isolated Linux user.
    // claude: yes (worker path); codex: yes (worker path); kiro: no
    // (KiroAcpServer spawns as the daemon user, see kiro-cli3-handoff.md).
    osUserIsolation: true,
    // Where "check usage" links point (client rate-limit panel).
    usageDashboard: {
      icon: "/claude-code-avatar.png",
      alt: "Claude",
      href: "https://claude.ai/settings/usage",
      title: "Check usage on claude.ai",
    },
    // Whether Clay tracks rate-limit state for this vendor.
    rateLimitTracking: true,
  },
  codex: {
    displayName: "Codex",
    loginCommand: "codex login --device-auth",
    binaryName: "codex",
    avatar: "/codex-avatar.png",
    sessionModes: ["gui"],
    osUserIsolation: true,
    usageDashboard: { /* current values from app-rate-limit.js:26-33 */ },
    rateLimitTracking: true,
  },
  kiro: {
    displayName: "Kiro CLI",
    loginCommand: "kiro-cli login",
    binaryName: "kiro-cli",
    avatar: "/kiro-avatar.svg",
    sessionModes: ["gui"],
    osUserIsolation: false,
    usageDashboard: null,
    rateLimitTracking: false,
  },
};

function getVendorInfo(vendor) {
  return VENDOR_REGISTRY[vendor] || null;
}

module.exports = { VENDOR_REGISTRY: VENDOR_REGISTRY, getVendorInfo: getVendorInfo };
```

Notes:

- **Verify every value against current behavior before writing it down.**
  The usageDashboard values above are placeholders; lift the real ones from
  `lib/public/modules/app-rate-limit.js:20-45` (`getVendorUsageMeta`). The
  claude usage href in particular must match what the client currently
  renders, not what this document guesses.
- Export from `lib/yoke/index.js` (add `getVendorInfo` and
  `VENDOR_REGISTRY` to its `module.exports`). Consumers must go through
  `require("./yoke")`, not deep-require the registry file, so the
  open-bridge migration can keep the same surface.
- The avatar path duplicates the client's `VENDOR_AVATARS`
  (`lib/public/modules/app-rendering.js:17-21`). That is acceptable for
  now: the client cannot import server CommonJS. The server copy exists for
  push notifications and any server-rendered surface; the client copy stays
  authoritative for the UI. Add a comment in both places pointing at each
  other.

### Serving static info to the client

Extend the `info` message (`lib/project-connection.js:135`) with a
`vendors` field:

```js
vendors: require("./yoke").VENDOR_REGISTRY,
```

(Strip nothing; it is all public UI metadata.) On the client, store it in
the zustand store as `vendorInfo` (add the key to the initial store in
`lib/public/app.js`, default `{}`), populated in the `"info"` case of
`lib/public/modules/app-messages.js`. Client modules then read
`store.get('vendorInfo')[vendor]` with the current hardcoded value as the
fallback expression, so a stale cached client cannot crash.

---

## Part 2: extend the dynamic capabilities map

Add these keys to `buildReadyResponse().capabilities` in each adapter.
They describe the **method surface that already exists**, so this is
documentation-as-data, not new behavior:

| key | claude | codex | kiro | evidence |
|---|---|---|---|---|
| `effort` | true | true | **false** | kiro `setEffort` is a stub (`kiro.js:770`) |
| `fork` | true | true | **false** | kiro `forkSession` returns null (`kiro.js:1138`) |
| `rollback` | false | true | false | codex `rollbackThread` (`codex.js`) |
| `sessionListing` | true | **false** | **false** | codex/kiro `listSessions` return [] (`codex.js:1558`, `kiro.js:1136`) |
| `sessionRename` | true | **false** | **false** | stubs at `codex.js:1559`, `kiro.js:1137` |

Verify each "true" by reading the adapter method body, not by trusting
this table; claude's `listSessions`/`forkSession` in particular should be
confirmed functional before being declared.

**Correctness fix while you are there:** kiro declares
`toolPolicy: ["ask", "allow-all"]` (`kiro.js:879`) but its `setToolPolicy`
is a no-op stub (`kiro.js:771`). Either implement it (map "allow-all" to
auto-approving in `canUseTool`, NOT to Kiro's autopilot, which must stay
off per `kiro-cli3-handoff.md`) or declare `toolPolicy: ["ask"]`. Declaring
what the stub cannot do is the bug this whole handoff exists to prevent;
do not leave it.

The existing 9 keys (`thinking`, `betas`, `rewind`, `sessionResume`,
`promptSuggestions`, `elicitation`, `fileCheckpointing`,
`contextCompacting`, `toolPolicy`) stay unchanged.

---

## Part 3: replacement inventory

Work through these one by one. Each row names the site, what it hardcodes,
and the replacement. Semantics must not change; this is a mechanical
substitution pass, and any site where the substitution would NOT be
behavior-preserving must be flagged in the PR description instead of
silently altered.

### Server side (all in scope)

| # | Site | Hardcodes | Replacement |
|---|---|---|---|
| S1 | `lib/sdk-bridge.js:153-155` (`loginCommandForVendor`) | login command switch | `getVendorInfo(vendor).loginCommand`, keep `"claude login"` as final fallback |
| S2 | `lib/sdk-bridge.js:872` | display-name ternary | `getVendorInfo(...).displayName` |
| S3 | `lib/sdk-message-processor.js:53-58` | auth title + login command ternaries | build from `displayName` + `loginCommand` ("<displayName> is not logged in.") |
| S4 | `lib/project-notifications.js:24` | display-name ternary | `displayName` |
| S5 | `lib/sdk-bridge.js:1073` (`ensureVendorReady`) | `linuxUser && vendor === "kiro"` | `linuxUser && getVendorInfo(vendor) && !getVendorInfo(vendor).osUserIsolation` |
| S6 | `lib/sdk-bridge.js:1111` (startQuery refusal) | same | same pattern; keep the user-facing error text but derive the vendor name from `displayName` |
| S7 | `lib/sdk-bridge.js:1549` (`getAvailableVendors`) | same | same pattern |
| S8 | `lib/sdk-bridge.js` `detectInstalledVendors` (kiro block, ~:1532-1541) | binary name + linuxUser gating | gate on `osUserIsolation` from registry; binary lookup may keep using `findKiroPath` for now (see "out of scope") |
| S9 | `lib/yoke/index.js:314-323` (`createAdapters` kiro gate) | `installed.kiro && !opts.osUsers` | generic loop guard: skip any vendor whose registry says `osUserIsolation: false` when `opts.osUsers` is set. Keep the log line, derive the name from registry |
| S10 | `lib/yoke/index.js:337-340` (`lazyCreateAdapter` kiro gate) | `vendor === "kiro" && (osUsers \|\| linuxUser)` | same generic guard |
| S11 | `lib/project-sessions.js:433` (new_session mode forcing) | `vendor === "codex" \|\| vendor === "kiro"` forces gui | `sessionModes.indexOf("tui") === -1` forces gui. Preserve the current default: unknown vendor (no registry entry) must still force gui |
| S12 | `lib/project-sessions.js:628` (switch_session TUI resolve) | `vendor === "claude" \|\| !vendor` | `!vendor \|\| sessionModes.indexOf("tui") !== -1`. NOTE: the `!vendor` (legacy sessions with no vendor recorded) branch must keep working exactly as today |
| S13 | `lib/project-sessions.js:681` (resume_tui_session) | same | same |
| S14 | `lib/project-sessions.js:709` (suspend_tui_session) | same | same |

S12-S14 deserve extra care: they gate the TUI machinery, which is
claude-only for a real structural reason (the PTY spawns `claude
--session-id/--resume`, `project-sessions.js:462,684`). Expressing it as
`sessionModes` keeps that truth in the registry, but if a future vendor
ever declares "tui" it will hit claude-specific spawn code. Add a comment
at the spawn site saying the command construction is claude-specific and
must be generalized before any other vendor declares "tui".

### Client side (in scope)

| # | Site | Hardcodes | Replacement |
|---|---|---|---|
| C1 | `lib/public/modules/app-notifications.js:255,335,369,429` | codex/claude login-command fallbacks | prefer the server-sent `loginCommand` (already in `authMeta`/msg), fall back to `store.vendorInfo[vendor].loginCommand`, then `"claude login"` |
| C2 | `lib/public/modules/app-messages.js:1362` | `"Codex"/"Claude"` login title | `VENDOR_NAMES[vendor]` (already imported in that file) |
| C3 | `lib/public/modules/app-rate-limit.js:20-45` (`getVendorUsageMeta`) | usage dashboard per vendor | `store.vendorInfo[vendor].usageDashboard` with current object as fallback |
| C4 | `lib/public/modules/app-rate-limit.js:181` | `currentVendor !== "claude"` hides rate-limit UI | `vendorInfo[currentVendor].rateLimitTracking === false` (fallback: current behavior) |
| C5 | `lib/public/modules/tui-grab.js:634` | `vendor !== "claude"` skips TUI grab | `vendorInfo[vendor].sessionModes` lacks "tui" (fallback: current behavior) |
| C6 | `lib/public/modules/input.js:303-304` | duplicate `_vendorAvatars`/`_vendorNames` literals | delete; import `VENDOR_AVATARS`/`VENDOR_NAMES` from `./app-rendering.js` (input.js already has other imports; check for cycles with `node scripts/check-client-imports.js`) |
| C7 | `lib/public/modules/app-panels.js:645` (`isClaude` gating MODE/THINKING sections) | vendor string | gate THINKING on `store.vendorCapabilities.thinking`; MODE list stays vendor-gated for now (modes are a claude concept in this UI), leave with a TODO comment |

### Explicitly OUT of scope (do not touch)

- `lib/public/modules/app-panels.js:365` (`rebuildCodexSections`): the
  approval/sandbox/websearch sections are genuinely codex-only config UI
  backed by codex-specific WS messages (`set_codex_approval` etc).
  Capability-gating them properly belongs to the adapterOptions teardown
  (capability model v2), not this pass.
- `adapterOptions.CLAUDE/CODEX/KIRO` (`lib/sdk-bridge.js:1342-1373`): v2.
- `detectInstalledVendors` binary lookup consolidation with
  `yoke/index.js checkInstalled()`: real duplication, but it has
  multi-user `su` semantics that need their own careful pass. Note it in
  the PR description as known follow-up.
- Vendor-name checks that are UI copy, not logic (e.g. placeholder text
  built from `VENDOR_NAMES`) are already registry-driven client-side.
- `lib/project-sessions.js:938-958` (`set_vendor` rebind guard): vendor
  comparison between two session fields, not a hardcoded vendor name.

---

## Part 4: tests

New file `test/yoke-vendor-registry.test.js` (node:test, CommonJS, same
style as `test/kiro-acp-routing.test.js`):

1. **Registry completeness:** for each vendor the adapter factory supports
   (assert on the literal list `["claude", "codex", "kiro"]`, and add a
   comment to `lib/yoke/index.js createAdapter` telling future vendors to
   update the registry + this test), `getVendorInfo(v)` returns an object
   with `displayName` (string), `loginCommand` (string), `sessionModes`
   (non-empty array of "gui"/"tui"), `osUserIsolation` (boolean),
   `rateLimitTracking` (boolean).
2. **Unknown vendor:** `getVendorInfo("nope")` returns null.
3. **Mode invariant:** every vendor's `sessionModes` contains "gui".
4. **Kiro isolation invariant:** `getVendorInfo("kiro").osUserIsolation`
   is false (this is load-bearing for the multi-user credential-leak guard;
   see `kiro-cli3-handoff.md` phase 3b). If per-user Kiro spawning is ever
   implemented, this test is the tripwire that forces revisiting S5-S10.
5. **Capabilities honesty (kiro):** using the `_AcpServerCtor`/`_fetchModels`
   injection seams from `test/kiro-adapter-init.test.js`, init a fake kiro
   adapter and assert `capabilities.effort === false` and that `toolPolicy`
   matches whatever Part 2's decision was.

Keep `npm test` green throughout; the existing 51+ tests must not change.

---

## Suggested commit split

1. `feat(yoke): add static vendor registry and extend capability map`
   (registry file, index.js exports, adapter capability additions, kiro
   toolPolicy fix, new tests)
2. `refactor: replace server-side vendor conditionals with registry lookups`
   (S1-S14)
3. `refactor(ui): drive vendor metadata from server-sent registry`
   (info message field, store key, C1-C7)

Run the full check block after each commit. Draft the commits, show Chad,
and wait for approval before pushing anywhere.

---

## Acceptance criteria

1. `grep -rnE 'vendor === "(codex|kiro|claude)"' lib --include='*.js' | grep -v yoke`
   returns ONLY the out-of-scope list above (document the surviving lines
   in the PR description with one-line justifications).
2. Behavior unchanged: new codex/kiro session still forces GUI; claude TUI
   resume/suspend still works; OS-isolated users still cannot see or start
   kiro; login prompts show the same commands; usage links unchanged.
   Verify in a live `npm run dev` session, all three vendors.
3. Kiro's declared capabilities no longer promise stubbed behavior.
4. `npm test` green including the new registry tests; all three static
   sweeps green.
5. No new requires from `lib/yoke` into clay-internal modules.
