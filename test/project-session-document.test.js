var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var attachSessionDocument = require("../lib/project-session-document").attachSessionDocument;

function readResult(result) {
  return JSON.parse(result.content[0].text);
}

test("presentation tool snapshots Markdown and sends it only to the bound session", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-document-mcp-"));
  var filePath = path.join(root, "guide.md");
  fs.writeFileSync(filePath, "# Before\n");
  var sent = [];
  var documents = attachSessionDocument({
    cwd: root,
    isMate: false,
    sendToSession: function (sessionId, message) { sent.push({ sessionId: sessionId, message: message }); },
  });
  var tool = documents.getToolDefs({ localId: 42 })[0];

  try {
    var result = await tool.handler({ path: "guide.md" });
    assert.deepStrictEqual(readResult(result), { ready: true, path: "guide.md" });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].sessionId, 42);
    assert.strictEqual(sent[0].message.type, "markdown_edit_present");
    assert.strictEqual(sent[0].message.content, "# Before\n");
    assert.strictEqual(sent[0].message.exists, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("presentation tool supports new Markdown files and rejects unsafe targets", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-document-mcp-"));
  var sent = [];
  var documents = attachSessionDocument({
    cwd: root,
    isMate: false,
    sendToSession: function (sessionId, message) { sent.push(message); },
  });
  var tool = documents.getToolDefs({ localId: 7 })[0];

  try {
    var created = await tool.handler({ path: "new-document.md" });
    assert.deepStrictEqual(readResult(created), { ready: true, path: "new-document.md" });
    assert.strictEqual(sent[0].content, "");
    assert.strictEqual(sent[0].exists, false);

    var outside = await tool.handler({ path: "../outside.md" });
    assert.strictEqual(outside.isError, true);
    var source = await tool.handler({ path: "app.js" });
    assert.strictEqual(source.isError, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("document MCP contract is explicit about primary versus incidental edits", function () {
  var server = require("../lib/session-document-mcp-server");
  var tool = server.getToolDefs({ present: function () {} })[0];
  assert.match(tool.description, /primary request/);
  assert.match(tool.description, /Do not call for incidental documentation changes/);
});

test("document presentation is wired as a hidden auto-approved session tool", function () {
  var project = fs.readFileSync(path.join(__dirname, "../lib/project.js"), "utf8");
  var bridge = fs.readFileSync(path.join(__dirname, "../lib/sdk-bridge.js"), "utf8");
  var messages = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-messages.js"), "utf8");
  assert.match(project, /_sessionDocument\.getToolDefs\(session\)/);
  assert.match(project, /server: "clay-documents"/);
  assert.match(project, /inAppNames\[i\] === "clay-documents"\) continue/);
  assert.match(project, /Session-bound tool requires a valid Clay session/);
  assert.match(bridge, /mcp__clay-documents__present_markdown_edit/);
  assert.match(messages, /msg\.name === "present_markdown_edit"/);
  assert.match(messages, /name: msg\.name, input: null, done: true, hidden: true/);
});
