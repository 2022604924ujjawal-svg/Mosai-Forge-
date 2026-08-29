# Handoff: split view spike (iframe pane shell)

**Status:** proposed / ready to implement
**Author:** handoff from Chad + Claude, 2026-08-16
**Branch:** `spike/split-view-iframe` from `main`
**Issue:** #387 (split screen sessions)

---

## Mission and decision context

Chad wants pure, symmetric split view: iTerm-style panes where every pane is
a fully functional session view, arranged by dragging, within one project or
across projects. His daily workflow is exactly this in a terminal: one agent
authoring handoffs on the left, another implementing on the right.

Two architectures can deliver symmetric panes:

- **Component refactor**: make the session view instantiable (the 2026-04
  plan on branch `feat/split-view`, docs only, never started). Months of
  invisible refactoring across ~80 client modules before any user value.
- **Iframe composition**: each pane is a chrome-less instance of the
  existing app. This is the literal translation of the iTerm model
  (independent instances + a window manager). Near-zero refactor; every
  feature (chat, tools, permissions, TUI/xterm, vendor UI) works in every
  pane because it IS the app.

The old plan bans iframes, but records no reason ("a previous agent tried,
it was reverted"). We do not accept or reject an approach on an
undocumented ban. **This spike builds the iframe shell for real, against
explicit success and kill criteria, and records the verdict.** If it
passes, it becomes the MVP base. If it fails structurally, the failure is
finally documented and the component refactor becomes the plan.

Spike code quality: real code, project conventions (this may be hardened
into the MVP), but no feature flag, no persistence, no polish beyond the
criteria below.

### Why the server is already ready (verified)

- The active session is per WebSocket connection (`ws._clayActiveSession`),
  not per project. Two connections = two different live sessions in the
  same project. This is how multi-user presence and "this user in another
  tab" already work (comment at `lib/project-sessions.js:351-354`).
- Same-session co-viewing is supported (live runtime wins).
- Presence is keyed per user (`lib/project-connection.js:319-322`
  `userPresence.setPresence(slug, presenceKey, ...)`), so N panes do not
  multiply the user; they only fight over one presence slot (handled below).

## Constraints

- Root `CLAUDE.md` rules: `var`, no arrow functions, CommonJS server / ESM
  client, store.js pattern, English comments/commits, Angular commits, no
  localStorage for user state, modules < 500 lines, no commit/push/PR
  without Chad's approval.
- Keep green: `npm test`, both `node --check` sweeps,
  `node scripts/check-client-imports.js`.

---

## Verified facts you will build on (file:line checked 2026-08-16)

| Fact | Where |
|---|---|
| Client boots per project from the URL path (`/p/<slug>`), ws path derived as `/p/<slug>/ws` | `lib/public/app.js:78-80` |
| WS connects with `new WebSocket(proto + host + store.get('wsPath'))` | `lib/public/modules/app-connection.js:128` |
| URL-param handling precedent at boot (playbook param, URLSearchParams + replaceState cleanup) | `lib/public/app.js:974-986` |
| **TRAP:** the upgrade handler compares WS paths exactly. Slug-less branch requires `req.url !== "/ws"` reject (`lib/server.js:936-940`); the slugged branch strips the prefix and matches the remainder. `?pane=1` on the WS URL will be rejected until the comparison parses off the query string first | `lib/server.js:896-945+` — read the full slugged branch before touching it |
| Connect-time restore auto-switches the user's last active session | `lib/project-connection.js:131-134` (`findRestoredActiveSession`) |
| Presence written per user key on connect state changes and disconnect | `lib/project-connection.js:319-322` |
| Session switching from a client is `switch_session { id }` per ws | `lib/project-sessions.js:625+` |
| Sidebar session items are already draggable (bookmark drag sets `text/plain` = session id) | `lib/public/modules/sidebar-sessions.js:74-78` |
| Chrome elements to hide in pane mode: sidebar `#sidebar-column`, title bar rows (`.title-bar-sidebar`, project dropdown, branch chip), mobile nav, FAB, home hub | `lib/public/index.html:207+`, grep the ids before writing CSS |
| Auth is cookie/token based and same-origin; iframes inherit it | (no change needed; verify by loading `/p/<slug>` in a hand-made iframe first) |

---

## Scope of the spike

Exactly this, nothing more:

1. **Pane mode** (`/p/<slug>/?pane=1&session=<localId>`): the full app,
   chrome hidden, pinned to one session.
2. **Split host in the parent app**: the chat content area can hold the
   native view (normal mode) or a 2-pane vertical split of iframes.
3. **Entry**: drag a sidebar session item over the chat area; drop-zone
   overlay shows left/right halves; dropping opens the split with the
   current session in one pane (iframe) and the dragged session in the
   other.
4. **Exit**: each pane has a parent-rendered 24px header (session title +
   close). Closing down to one pane restores the native view on that
   session.
5. Both panes fully interactive concurrently.

Out of scope (MVP later, only if the spike passes): >2 panes, horizontal
splits and split trees, layout persistence, cross-project panes (should
work incidentally; note observed behavior but do not build UI), keyboard
shortcuts, mobile, presence/notification polish beyond the flags below.

---

## Implementation

### 1. Server: pane-aware WS connections

`lib/server.js` upgrade handler: parse `req.url` into path + query
(`url.parse` or manual split on `?`) BEFORE the `/ws` comparisons, for both
the slugged and slug-less branches. Thread `{ pane: true, paneSession: N }`
from the query into the connection handling so `project-connection.js` can
set `ws._clayPane = true`.

In `lib/project-connection.js` when `ws._clayPane`:

- **Skip the restore block** (`findRestoredActiveSession` switch): the pane
  pins its own session; restoring first causes a wrong-session flash and
  a wasted history replay.
- **Skip presence writes** for this ws (connect, switch, disconnect): panes
  must not fight the primary connection for the user's single presence
  slot. Grep every `setPresence` call on this ws's paths.
- Everything else stays identical: the pane is a normal client.

Do NOT trust the query's session id server-side beyond passing it through;
the client sends a normal `switch_session`, which already runs access
control.

### 2. Client: pane mode

In `lib/public/app.js` boot: read `URLSearchParams`; when `pane=1`:

- `document.body.classList.add("pane-mode")` and store
  `{ paneMode: true, paneSessionId: N }` (add both keys to the initial
  store).
- Append `?pane=1` to `wsPath` so the server sees the flag.
- After the first `session_list` arrives (`app-messages.js`), if
  `paneSessionId` is set and present in the list, send
  `switch_session { id }` once and clear the pending pin. If the session
  is missing (deleted), leave the blank state; do not fall back to
  restore.

New CSS (a small `pane-mode` block in an existing stylesheet or
`lib/public/css/pane.css` + index.html link): `body.pane-mode` hides
`#sidebar-column`, the title-bar rows, mobile nav, FAB, and anything else
that renders chrome. CSS-only hiding is acceptable for the spike; skipping
chrome JS init is an MVP optimization, not spike scope. Keep the composer,
messages, config chip, and TUI surfaces fully functional.

`beforeunload`/`session_switched`-driven things that touch
`document.title` or the favicon (`app-favicon.js`) should no-op in pane
mode (`store.get('paneMode')` guard) so panes do not fight over the tab
title.

### 3. Parent shell: split host + drag

New module `lib/public/modules/split-view.js` (ESM, keep under 300 lines),
initialized from `app.js`:

- **State** in the store: `splitPanes` (null or
  `[{ slug, sessionId, title }, { ... }]`).
- **DOM**: a `#split-host` div inserted as a sibling of the existing chat
  content inside `#main-column`/`#main-panels` (read the actual layout
  first; the host must occupy exactly the area the native chat view
  occupies, not cover the sidebar or title bar). When `splitPanes` is
  set: hide the native chat area (`display:none`, do not unmount),
  render two `.split-pane` columns, each = header bar (title from the
  parent's cached session list + close button) + `<iframe
  src="/p/<slug>/?pane=1&session=<id>">`.
- **Drag entry**: `dragover`/`drop` listeners on the chat content area.
  Session drags are recognized by the existing `text/plain` session-id
  payload (`sidebar-sessions.js:74-78` dragstart). While a session drag is
  over the area, show a two-zone overlay (left/right). IMPORTANT: the
  overlay must sit ABOVE any iframe (`pointer-events` + z-index), because
  iframes swallow drag events; the parent owning all drop zones is what
  makes cross-iframe drag a non-problem.
- **Drop**: left zone = dragged session left, current session right; right
  zone = mirror. Entering split converts the current native session into
  a pane too (both panes are iframes; symmetric by design).
- **Close**: closing a pane with 2 open → survivor becomes the native view
  again (send `switch_session` on the parent ws to the survivor's session,
  show native area, clear `splitPanes`, remove iframes).
- Sidebar clicks while split is active: for the spike, clicking a session
  in the sidebar exits split to native on that session (simplest coherent
  rule; focused-pane routing is MVP polish). State the rule in a comment.

### 4. Things to watch and record (not necessarily fix)

Record observed behavior in the verification log for each:

- Memory per pane (Chrome task manager, rough numbers).
- TUI/xterm inside an iframe, including WebGL renderer.
- Notification/unread double-counting with a pane open on the same session
  the parent sidebar tracks.
- What happens on daemon restart / reconnect inside panes (each pane has
  its own reconnect overlay; is it tolerable?).
- A cross-project pane (`/p/other?pane=1&session=N`) opened by hand.

---

## Success criteria (all must hold)

1. Two panes, same project, different sessions: both stream concurrently;
   typing in each composer works; a permission prompt raised in either pane
   is answerable in that pane.
2. One pane running a TUI session renders and accepts input while the
   other pane chats.
3. Entering split via drag (both zones) and exiting via close both work
   and land in a coherent state, repeatedly.
4. The pinned-session flash is absent (no restore-then-switch flicker).
5. `npm test` + sweeps stay green; normal (non-split) mode is pixel-wise
   unchanged.

## Kill criteria (structural failure -> stop, document, recommend refactor)

- WS or auth cannot work per iframe for a structural reason.
- xterm/TUI fundamentally broken inside iframes (not a CSS issue).
- Per-pane memory so high that 2 panes are impractical on a dev laptop.
- An unfixable interaction class (not a polish item) between parent chrome
  and pane apps.

Anything else found is a POLICY item: list it, do not let it kill the
spike.

---

## Deliverable

The branch, plus a **verdict section appended to this file**: PASS (with
the policy-item list, becoming the MVP backlog) or FAIL (with the exact
structural reason, finally giving the iframe ban a rationale). Do not
open a PR without Chad's approval either way.

---

## Verification log

### 2026-08-16 — PASS

The iframe architecture passes the spike. There is no structural reason to
return to the component-refactor plan. The implementation is suitable as the
base for the split-view MVP.

Verified behavior:

- Opened same-project two-pane splits from both left and right drop zones.
  The requested order was preserved, the native view was hidden without being
  unmounted, and closing either pane restored the survivor through the parent
  WebSocket. Repeated entry/exit and a sidebar click while split were coherent.
- Loaded two independently pinned pane clients and typed different drafts in
  both composers. A fresh GUI pane streamed `SPLIT_STREAM_OK` from Claude and
  completed a Bash tool call.
- Raised a real Bash permission request inside a pane. The parent-rendered
  choices (`Sure`, `Allow for session`, `No`) were usable; choosing `No`
  returned the denial to the correct session.
- Ran a live Claude TUI in one pane while a GUI chat pane remained connected.
  xterm rendered at full pane height with three canvas elements (including the
  WebGL renderer path), and its terminal textarea accepted focus and input.
- Pane boot did not restore another active session first. A missing requested
  session remained blank instead of falling back. Pane connections did not
  write user presence on connect, session creation/switch, or disconnect.
- Restarted the isolated daemon. Each open pane displayed its own reconnect
  overlay and recovered independently. This exposed and fixed a reconnect bug:
  the URL pin is now retained for the page lifetime and applied once per new
  WebSocket, so a surviving local session id remains pinned after reconnect.
- Rough per-pane JavaScript heap samples were about 20 MB for GUI and 25 MB for
  TUI. Headless Chrome renderer RSS varied more widely (roughly 60–195 MB) and
  is not a clean per-pane delta, but two live panes remained responsive with no
  memory-related failure.
- Normal mode showed no visual change in browser inspection. Its only layout
  addition is an inert hidden split host/overlay; pane chrome rules are scoped
  to `body.pane-mode`.

Automated verification:

- `npm test`: 88 passed, 0 failed.
- Server CommonJS and client ESM `node --check` sweeps: passed.
- `node scripts/check-client-imports.js`: all 84 client modules resolved.
- `git diff --check`: passed.

Policy items for the MVP backlog:

- Pane sockets still count as raw connected clients even though they are
  excluded from presence. Decide whether client-count UI should show people,
  tabs, or transport connections.
- Unread/notification semantics need a focused-pane policy. Because panes do
  not own presence, the parent may still treat activity visible in a pane as
  unread.
- Reconnect overlays are per iframe. This was tolerable with two panes but will
  need coordinated presentation before supporting larger split trees.
- Parent file/terminal side-panel actions and sidebar session clicks currently
  exit the split instead of routing to a focused pane. Focused-pane routing is
  MVP work.
- Cross-project pane URLs were not exercised because the isolated test server
  had one registered project. The shell state already carries a slug per pane,
  but the MVP needs UI and an explicit cross-project test.
- Layout persistence, more than two panes, horizontal/tree layouts, keyboard
  controls, mobile behavior, and memory optimization remain intentionally out
  of scope for this spike.
