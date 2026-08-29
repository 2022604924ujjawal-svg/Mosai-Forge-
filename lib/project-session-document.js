var fs = require("fs");
var path = require("path");
var sessionDocumentMcp = require("./session-document-mcp-server");

var DOCUMENT_PROMPT = "When the user's primary request is to create or revise Markdown, call present_markdown_edit once per targeted document with its resolved .md/.mdx path, immediately before that document's first Edit or Write. Do not call it for incidental Markdown changes during coding, maintenance, tests, or refactoring.";

function toolResult(value) {
  return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(value) }] });
}

function toolError(message) {
  return Promise.resolve({
    content: [{ type: "text", text: "Error: " + message }],
    isError: true,
  });
}

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function attachSessionDocument(ctx) {
  var cwd = fs.realpathSync(ctx.cwd);
  var isMate = ctx.isMate;
  var sendToSession = ctx.sendToSession;
  var fsMaxSize = ctx.FS_MAX_SIZE || 512 * 1024;
  var getOsUserInfoForSession = ctx.getOsUserInfoForSession || function () { return null; };
  var fsAsUser = ctx.fsAsUser;

  function resolveMarkdownPath(requested) {
    if (typeof requested !== "string" || !requested.trim()) return null;
    var target = path.resolve(cwd, requested.trim());
    if (!isInside(cwd, target) || !/\.mdx?$/i.test(target)) return null;
    try {
      var realTarget = fs.realpathSync(target);
      return isInside(cwd, realTarget) ? realTarget : null;
    } catch (e) {
      try {
        var realParent = fs.realpathSync(path.dirname(target));
        return isInside(cwd, realParent) ? path.join(realParent, path.basename(target)) : null;
      } catch (parentError) {
        return null;
      }
    }
  }

  function readSnapshot(target, caller) {
    if (!fs.existsSync(target)) return { content: "", exists: false, size: 0 };
    var osUserInfo = getOsUserInfoForSession(caller);
    if (osUserInfo && typeof fsAsUser === "function") {
      var statResult = fsAsUser("stat", { file: target }, osUserInfo);
      if (statResult.size > fsMaxSize) throw new Error("Markdown file is too large to present live");
      var readResult = fsAsUser("read", { file: target, readContent: true }, osUserInfo);
      return { content: readResult.content || "", exists: true, size: statResult.size };
    }
    var stat = fs.statSync(target);
    if (stat.size > fsMaxSize) throw new Error("Markdown file is too large to present live");
    return { content: fs.readFileSync(target, "utf8"), exists: true, size: stat.size };
  }

  function present(args, caller) {
    if (!caller) return toolError("present_markdown_edit requires a session-bound tool server");
    var target = resolveMarkdownPath(args.path);
    if (!target) return toolError("path must be a .md or .mdx file inside the project");
    try {
      var snapshot = readSnapshot(target, caller);
      var relativePath = path.relative(cwd, target).split(path.sep).join("/");
      sendToSession(caller.localId, {
        type: "markdown_edit_present",
        path: relativePath,
        content: snapshot.content,
        exists: snapshot.exists,
        size: snapshot.size,
      });
      return toolResult({ ready: true, path: relativePath });
    } catch (e) {
      return toolError(e.message || String(e));
    }
  }

  function getToolDefs(boundSession) {
    if (isMate) return [];
    return sessionDocumentMcp.getToolDefs({
      present: function (args) { return present(args, boundSession || null); },
    });
  }

  function createMcpServer(adapter, boundSession) {
    if (isMate || !adapter || typeof adapter.createToolServer !== "function") return null;
    return adapter.createToolServer({
      name: "clay-documents",
      version: "1.0.0",
      tools: getToolDefs(boundSession || null),
    });
  }

  return {
    createMcpServer: createMcpServer,
    getSystemPrompt: function () { return isMate ? "" : DOCUMENT_PROMPT; },
    getToolDefs: getToolDefs,
  };
}

module.exports = {
  DOCUMENT_PROMPT: DOCUMENT_PROMPT,
  attachSessionDocument: attachSessionDocument,
};
