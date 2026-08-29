var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

async function loadMarkdownModule() {
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules/sticky-note-markdown.js"), "utf8");
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

function classList(names) {
  return {
    contains: function (name) { return names.indexOf(name) !== -1; },
  };
}

function textNode(text) {
  return { nodeType: 3, textContent: text };
}

function element(tagName, classes, children) {
  return {
    nodeType: 1,
    tagName: tagName,
    classList: classList(classes || []),
    childNodes: children || [],
    getAttribute: function () { return null; },
  };
}

test("sticky-note markdown renders bare and bulleted checklist markers", async function () {
  var markdown = await loadMarkdownModule();
  var html = markdown.renderMiniMarkdown("Handoff\n[x] Done\n[ ] Next\n- [X] Also done\n- [ ] Later");
  assert.strictEqual((html.match(/role=\"checkbox\"/g) || []).length, 4);
  assert.strictEqual((html.match(/aria-checked=\"true\"/g) || []).length, 2);
  assert.strictEqual((html.match(/aria-checked=\"false\"/g) || []).length, 2);
});

test("sticky-note checklist state serializes back to markdown", async function () {
  var markdown = await loadMarkdownModule();
  var title = element("DIV", ["sn-title"], [textNode("Handoff")]);
  var checked = element("SPAN", ["sn-check", "checked"], [textNode("✓")]);
  var unchecked = element("SPAN", ["sn-check"], [textNode("☐")]);
  var rendered = element("DIV", [], [
    title,
    element("BR"),
    checked,
    textNode(" Done"),
    element("BR"),
    unchecked,
    textNode(" Next"),
  ]);
  rendered.querySelector = function () { return title; };
  assert.strictEqual(markdown.extractMarkdown(rendered), "Handoff\n- [x] Done\n- [ ] Next");
});
