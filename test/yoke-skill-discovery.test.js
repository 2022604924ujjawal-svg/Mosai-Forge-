var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var skills = require("../lib/yoke/skill-discovery");
var kiroTestKit = require("../lib/yoke/adapters/kiro").contractTestKit;

function createSkill(root, directoryName, name, description, body) {
  var skillDir = path.join(root, directoryName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n\n" + body + "\n");
}

function withFixture(fn) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-skills-"));
  var homeDir = path.join(root, "home");
  var cwd = path.join(root, "project");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  try { return fn({ root: root, homeDir: homeDir, cwd: cwd }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("cross-vendor discovery merges roots with project precedence", function() {
  withFixture(function(fixture) {
    createSkill(path.join(fixture.homeDir, ".codex", "skills"), "review", "review", "Codex review", "Codex instructions");
    createSkill(path.join(fixture.homeDir, ".claude", "skills"), "review", "review", "Claude review", "Claude instructions");
    createSkill(path.join(fixture.cwd, "skills"), "deploy", "deploy", "Project deploy", "Deploy instructions");
    createSkill(path.join(fixture.cwd, ".claude", "skills"), "review", "review", "Project review", "Project instructions");

    var discovered = skills.discoverSkills(fixture.cwd, { homeDir: fixture.homeDir });
    var indexed = skills.indexSkills(discovered);

    assert.deepStrictEqual(discovered.map(function(skill) { return skill.name; }), ["deploy", "review"]);
    assert.strictEqual(indexed.review.source, "claude-project");
    assert.strictEqual(indexed.review.description, "Project review");
    assert.strictEqual(indexed.deploy.source, "project");
  });
});

test("cross-vendor discovery tolerates missing vendor directories", function() {
  withFixture(function(fixture) {
    assert.deepStrictEqual(skills.discoverSkills(fixture.cwd, { homeDir: fixture.homeDir }), []);
  });
});

test("Claude bridge exposes Codex skills without moving their source", function() {
  withFixture(function(fixture) {
    createSkill(path.join(fixture.homeDir, ".codex", "skills"), "audit", "audit", "Audit code", "Audit instructions");
    var pluginDir = skills.ensureClaudeCodexPlugin({ homeDir: fixture.homeDir });
    var skillsLink = path.join(pluginDir, "skills");

    assert.strictEqual(path.resolve(pluginDir, fs.readlinkSync(skillsLink)), path.join(fixture.homeDir, ".codex", "skills"));
    assert.strictEqual(skills.ensureClaudeCodexPlugin({ homeDir: fixture.homeDir }), pluginDir, "bridge creation must be idempotent");
    assert.strictEqual(fs.existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json")), true);
  });
});

test("Claude bridge refuses to replace an existing non-symlink skills path", function() {
  withFixture(function(fixture) {
    createSkill(path.join(fixture.homeDir, ".codex", "skills"), "audit", "audit", "Audit code", "Audit instructions");
    var occupied = path.join(fixture.homeDir, ".clay", "skill-bridge", "codex", "skills");
    fs.mkdirSync(occupied, { recursive: true });

    assert.strictEqual(skills.ensureClaudeCodexPlugin({ homeDir: fixture.homeDir }), null);
    assert.strictEqual(fs.lstatSync(occupied).isDirectory(), true);
  });
});

test("Claude bridge refuses a symlinked plugin directory", function() {
  withFixture(function(fixture) {
    createSkill(path.join(fixture.homeDir, ".codex", "skills"), "audit", "audit", "Audit code", "Audit instructions");
    var bridgeRoot = path.join(fixture.homeDir, ".clay", "skill-bridge");
    var redirected = path.join(fixture.root, "redirected");
    fs.mkdirSync(bridgeRoot, { recursive: true });
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, path.join(bridgeRoot, "codex"), "dir");

    assert.strictEqual(skills.ensureClaudeCodexPlugin({ homeDir: fixture.homeDir }), null);
    assert.deepStrictEqual(fs.readdirSync(redirected), []);
  });
});

test("Kiro injects explicitly referenced shared skill content", function() {
  withFixture(function(fixture) {
    createSkill(path.join(fixture.homeDir, ".claude", "skills"), "audit", "audit", "Audit code", "CHECK_SECURITY_RULES");
    var discovered = skills.discoverSkills(fixture.cwd, { homeDir: fixture.homeDir });
    var message = kiroTestKit.injectSharedSkillContent("Please use $audit", discovered);

    assert.match(message, /<shared-skill name="audit" source="claude-user">/);
    assert.match(message, /CHECK_SECURITY_RULES/);
  });
});

test("Kiro skill index supports automatic matching with readable paths", function() {
  var index = skills.buildSkillIndex([{
    name: "audit",
    description: "Audit code for security issues",
    path: "/skills/audit/SKILL.md",
  }]);

  assert.match(index, /When a task matches a description/);
  assert.match(index, /\$audit — Audit code for security issues — \/skills\/audit\/SKILL\.md/);
});
