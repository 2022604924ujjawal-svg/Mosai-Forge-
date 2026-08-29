// Live Markdown presentation tool for project sessions.

var buildShape = require("./session-spawn-mcp-server").buildShape;

function getToolDefs(handlers) {
  return [{
    name: "present_markdown_edit",
    description: "Call once per targeted document, immediately before its first Edit or Write, when the user's primary request is to create or revise Markdown. Pass the resolved .md or .mdx path. Do not call for incidental documentation changes made as part of coding, maintenance, tests, or refactoring. This prepares Clay's rendered document view so the user can watch every change.",
    inputSchema: buildShape({
      path: { type: "string", description: "Project-relative or absolute path to the Markdown document that will be edited." },
    }, ["path"]),
    handler: function (args) { return handlers.present(args || {}); },
  }];
}

module.exports = { getToolDefs: getToolDefs };
