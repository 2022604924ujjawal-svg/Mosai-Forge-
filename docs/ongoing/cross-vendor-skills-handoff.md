# Cross-vendor skill sharing (bidirectional)

**Goal:** every vendor session in Clay can discover and use every other
vendor's skills, in both directions. No unified store: skills stay where
each vendor installs them; yoke maps them across.

**Decision (Chad, 2026-08-16):** bidirectional is required (Claude must
also read Codex-side skills). A unified `~/.clay/skills` store was
explicitly rejected.

## Implemented state (verified 2026-08-16)

| Direction | State | Where |
|---|---|---|
| Instructions (CLAUDE.md/AGENTS.md/.cursorrules) | DONE, cross-shared | `lib/yoke/instructions.js` scanAndMerge |
| Codex reads shared skills, explicit `$name` | DONE | `codex.js` injects native `{type:"skill", name, path}` input items |
| Codex lists and auto-triggers Claude skills | DONE | `skills/extraRoots/set` registers foreign roots before `skills/list` |
| Kiro reads Claude and Codex skills | DONE | explicit references inject capped content; the system context contains the shared skill index |
| Claude reads Codex skills | DONE | safe local plugin shim passed through both in-process and worker SDK paths |
| All adapters list shared skills | DONE | `lib/yoke/skill-discovery.js` supplies the merged inventory |

Codex skill locations (verified in binary): `~/.codex/skills`, project
`./skills/`, `.agents/skills`, plugin `.codex-plugin` dirs. Format is
SKILL.md-compatible (openai/skills mirrors the Anthropic skills format).

## Design

### 1. Claude reads Codex skills (plugin shim)

Agent SDK supports `plugins?: SdkPluginConfig[]` where
`SdkPluginConfig = {type: 'local', path, ...}` (sdk.d.ts:1797, 4456).
A local plugin loads skills from `<plugin>/skills/`.

- At claude adapter init (or sdk-bridge startQuery), if `~/.codex/skills`
  exists and is non-empty, ensure a shim dir exists at
  `~/.clay/skill-bridge/codex/`:
  - `.claude-plugin/plugin.json` -> `{"name": "codex"}`
  - `skills` -> symlink to `~/.codex/skills`
- Pass `plugins: [{type: "local", path: <shim>}]` in SDK options
  (claude.js in-process path ~1356 and worker path ~1509, same plumbing
  as `thinking`).
- Skills appear namespaced as `codex:<name>`. SDK option field 4466
  suggests setting the manifest-MCP suppression flag so a codex plugin
  dir can never register MCP servers through this path.
- SAFETY RAIL: shim creation must be idempotent, must not follow an
  existing non-symlink at the target, and must skip silently when
  `~/.codex` does not exist (codex not installed).

### 2. Codex auto-triggers Claude skills (thread-level roots)

- PROBE FIRST (live binary, app-server): determine the exact param shape
  of `skills/extraRoots/set` (or whether `thread/start` accepts
  `selectedCapabilityRoots` directly). Probe with a scratch thread; do
  not guess field names (KIRO-INTEGRATION.md sets the precedent).
- After `thread/start`/`thread/resume` succeeds (codex.js:949), register
  `~/.claude/skills` and `<cwd>/.claude/skills` as extra roots for the
  session so codex's native progressive disclosure sees them.
- Keep the existing `$name` injection path: it covers resumed threads
  and older servers. Wrap the new call in try/catch; on failure log and
  continue (explicit invocation still works).

### 3. Kiro gets real skill injection + auto-trigger index

- Implement `$name` parsing in the kiro adapter mirroring
  codex.js:40-56, but inject the SKILL.md CONTENT as a context block in
  the ACP prompt (kiro has no skill input item type). Truncate at a safe
  cap (~32k chars) with a note.
- Auto-trigger: on session start, inject a compact skill index into the
  ACP context: one line per skill, `name - description` (description
  parsed from SKILL.md frontmatter), plus the instruction "when a task
  matches a skill description, read its SKILL.md at <path> with your
  file tools before proceeding". Kiro can read the path itself; no
  content duplication.
- Index must include Claude skills AND Codex skills (see 4).

### 4. Unified discovery helper (shared, pure)

New module `lib/yoke/skill-discovery.js` (CJS, pure, unit-testable):
- `discoverSkills(cwd)` -> `[{name, path, description, source}]`
  scanning, in priority order (later wins on name conflict):
  `~/.codex/skills`, `~/.claude/skills`, `<cwd>/skills`,
  `<cwd>/.claude/skills`.
- Frontmatter parse: `name:`/`description:` from the SKILL.md YAML
  header, fall back to dir name / first heading.
- Replace the duplicated `discoverClaudeSkills` in codex.js:13-37 and
  kiro.js:25-48 with this module. Both adapters then also expose codex
  skills for `$name` and palettes.
- capability map: add `skillSharing: true` where wired (claude, codex,
  kiro all true when done); vendor checks stay out of adapters' callers
  per the yoke rule.

## Out of scope

- Unified skill store / Clay UI for installing skills (rejected).
- Kiro-native agents/steering as a skill source (revisit later).
- Watching skill dirs for live changes (SDK has reload_skills; codex has
  skills/list forceReload; fine to require session restart for now).

## Tests

- skill-discovery: fixture dirs for both vendors, conflict priority,
  frontmatter parsing, missing dirs.
- shim creation: idempotency, refuses to clobber a real dir, skips when
  ~/.codex missing (use temp HOME).
- kiro $name parsing: mirrors existing codex parse tests if any; content
  injection block shape.

## Acceptance (live)

1. Claude session: `/codex:<some-codex-skill>` (or auto-trigger) works;
   skill listed in the command palette.
2. Codex session: a Claude skill auto-triggers from its description
   without `$name` (requires probe result from step 2).
3. Kiro session: `$<claude-skill>` actually changes behavior (content
   delivered); skill index visible in first-turn context (debug log).
4. All three: codex-installed skill appears in the palette.
5. Daemon restart required before testing (server files).

## Implementation verification

- Codex 0.147 JSON schema confirmed `skills/extraRoots/set` accepts
  `{extraRoots: string[]}`. A live app-server initialization registered the
  roots and returned 22 merged skills.
- Claude CLI `plugin validate` accepted the generated bridge. It noted that
  validation does not follow the skills symlink, while runtime plugin loading
  does.
- `npm test` passes all 122 tests, including the new cross-vendor discovery,
  shim safety, and Kiro injection coverage.
