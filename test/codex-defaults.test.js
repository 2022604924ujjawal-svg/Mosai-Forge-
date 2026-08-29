var test = require("node:test");
var assert = require("node:assert");

var codexDefaults = require("../lib/codex-defaults");

test("Codex approval policy accepts current SDK values", function() {
  var policies = codexDefaults.CODEX_APPROVAL_POLICIES;
  for (var i = 0; i < policies.length; i++) {
    assert.strictEqual(codexDefaults.normalizeCodexApproval(policies[i]), policies[i]);
  }
});

test("Codex approval policy migrates removed and invalid values", function() {
  assert.strictEqual(codexDefaults.normalizeCodexApproval("on-failure"), "on-request");
  assert.strictEqual(codexDefaults.normalizeCodexApproval("invalid"), "on-request");
  assert.strictEqual(codexDefaults.normalizeCodexApproval(), "on-request");
});
