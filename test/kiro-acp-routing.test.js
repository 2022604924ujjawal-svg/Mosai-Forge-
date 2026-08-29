var test = require("node:test");
var assert = require("node:assert");

var { KiroAcpServer } = require("../lib/yoke/kiro-acp-server");

// One ACP child process is shared by every session in a project, so
// server-initiated messages have to be routed by params.sessionId. The failure
// mode these tests guard against is a dropped server -> client *request*:
// requests carry an id and kiro-cli blocks on the response until the
// session/prompt timeout (30 minutes), with no error surfaced to the user.

// Build a server instance without spawning anything, and capture what it would
// write to the child's stdin.
function makeServer() {
  var srv = new KiroAcpServer("/nonexistent/kiro-cli", {});
  srv.started = true;
  srv.proc = { stdin: { write: function () { return true; } } };
  srv.written = [];
  srv._write = function (msg) { srv.written.push(msg); };
  return srv;
}

function permissionRequest(id, sessionId) {
  return {
    jsonrpc: "2.0",
    id: id,
    method: "session/request_permission",
    params: { sessionId: sessionId, toolCall: { toolCallId: "tc1" }, options: [] },
  };
}

// ============================================================
// 1. Routing by sessionId
// ============================================================

test("routes a session event to the handler bound to that session", function () {
  var srv = makeServer();
  var seenA = [];
  var seenB = [];
  var a = srv.addHandler(function (m) { seenA.push(m); });
  var b = srv.addHandler(function (m) { seenB.push(m); });
  a.sessionId = "sess-a";
  b.sessionId = "sess-b";

  srv._handleMessage({ method: "session/update", params: { sessionId: "sess-b", update: {} } });

  assert.strictEqual(seenA.length, 0, "handler A should not see session B's event");
  assert.strictEqual(seenB.length, 1, "handler B should receive its own event");
});

test("a second query does not steal the first query's permission requests", function () {
  // This is the original bug: a single eventHandler slot meant the newest query
  // overwrote the previous one, and the older session's permission request was
  // silently dropped.
  var srv = makeServer();
  var answeredA = [];
  var a = srv.addHandler(function (m) { answeredA.push(m); });
  a.sessionId = "sess-a";

  // Second session starts while the first is still running.
  var b = srv.addHandler(function () {});
  b.sessionId = "sess-b";

  srv._handleMessage(permissionRequest(7, "sess-a"));

  assert.strictEqual(answeredA.length, 1, "session A's handler must still receive its request");
  assert.strictEqual(answeredA[0].id, 7);
});

// ============================================================
// 2. Unroutable requests must be answered, never dropped
// ============================================================

test("responds with an error when no handler matches a request", function () {
  var srv = makeServer();
  var a = srv.addHandler(function () { assert.fail("should not be called"); });
  a.sessionId = "sess-a";

  srv._handleMessage(permissionRequest(42, "sess-gone"));

  assert.strictEqual(srv.written.length, 1, "an unroutable request must still get a reply");
  assert.strictEqual(srv.written[0].id, 42);
  assert.ok(srv.written[0].error, "reply should be a JSON-RPC error");
});

test("responds with an error when there are no handlers at all", function () {
  var srv = makeServer();

  srv._handleMessage(permissionRequest(1, "sess-a"));

  assert.strictEqual(srv.written.length, 1);
  assert.ok(srv.written[0].error);
});

test("a notification with no matching handler is dropped without a reply", function () {
  var srv = makeServer();

  srv._handleMessage({ method: "session/update", params: { sessionId: "sess-gone", update: {} } });

  assert.strictEqual(srv.written.length, 0, "notifications carry no id and must not be answered");
});

test("a throwing handler still produces an error response", function () {
  var srv = makeServer();
  var a = srv.addHandler(function () { throw new Error("boom"); });
  a.sessionId = "sess-a";

  srv._handleMessage(permissionRequest(9, "sess-a"));

  assert.strictEqual(srv.written.length, 1, "a handler crash must not leave kiro-cli hanging");
  assert.strictEqual(srv.written[0].id, 9);
  assert.ok(srv.written[0].error);
});

test("a request is delivered to exactly one handler", function () {
  // Two handlers on the same session must not both answer: responding twice to
  // one JSON-RPC id is a protocol violation.
  var srv = makeServer();
  var calls = 0;
  var a = srv.addHandler(function () { calls++; });
  var b = srv.addHandler(function () { calls++; });
  a.sessionId = "sess-a";
  b.sessionId = "sess-a";

  srv._handleMessage(permissionRequest(3, "sess-a"));

  assert.strictEqual(calls, 1, "only the first matching handler should answer");
});

// ============================================================
// 3. Handler lifecycle
// ============================================================

test("removeHandler stops routing to a finished query", function () {
  var srv = makeServer();
  var seen = 0;
  var a = srv.addHandler(function () { seen++; });
  a.sessionId = "sess-a";

  srv.removeHandler(a);
  srv._handleMessage(permissionRequest(5, "sess-a"));

  assert.strictEqual(seen, 0, "a removed handler must not receive events");
  assert.strictEqual(srv.written.length, 1, "and the request must be rejected rather than dropped");
  assert.ok(srv.written[0].error);
});

test("removeHandler is idempotent and does not disturb other handlers", function () {
  var srv = makeServer();
  var a = srv.addHandler(function () {});
  var seenB = 0;
  var b = srv.addHandler(function () { seenB++; });
  a.sessionId = "sess-a";
  b.sessionId = "sess-b";

  srv.removeHandler(a);
  srv.removeHandler(a);

  assert.strictEqual(srv.handlers.length, 1);
  srv._handleMessage({ method: "session/update", params: { sessionId: "sess-b", update: {} } });
  assert.strictEqual(seenB, 1);
});

test("a handler with no sessionId yet receives no session-tagged events", function () {
  // Between addHandler() and session/new resolving, the entry has no sessionId.
  var srv = makeServer();
  var seen = 0;
  srv.addHandler(function () { seen++; });

  srv._handleMessage({ method: "session/update", params: { sessionId: "sess-a", update: {} } });

  assert.strictEqual(seen, 0);
});

// ============================================================
// 4. Process-wide events fan out to every session
// ============================================================

test("an event with no sessionId reaches every active handler", function () {
  var srv = makeServer();
  var seenA = 0;
  var seenB = 0;
  var a = srv.addHandler(function () { seenA++; });
  var b = srv.addHandler(function () { seenB++; });
  a.sessionId = "sess-a";
  b.sessionId = "sess-b";

  srv._handleMessage({ method: "_kiro/error", params: { error: { message: "unauthorized" } } });

  assert.strictEqual(seenA, 1, "auth failure is process-wide, session A should see it");
  assert.strictEqual(seenB, 1, "auth failure is process-wide, session B should see it");
});

test("a stderr auth signal is delivered to active sessions", function () {
  var srv = makeServer();
  var seen = [];
  var a = srv.addHandler(function (m) { seen.push(m); });
  a.sessionId = "sess-a";

  srv._maybeSignalAuthError("Error: not logged in, run kiro-cli login");

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].method, "_kiro/error");
  assert.strictEqual(seen[0].params.error.kiroErrorInfo, "unauthorized");
});

test("repeated auth signals are deduped", function () {
  var srv = makeServer();
  var seen = 0;
  var a = srv.addHandler(function () { seen++; });
  a.sessionId = "sess-a";

  srv._maybeSignalAuthError("not logged in");
  srv._maybeSignalAuthError("not logged in");
  srv._maybeSignalAuthError("not logged in");

  assert.strictEqual(seen, 1, "a burst of stderr lines should collapse to one event");
});

// ============================================================
// 5. Responses still resolve their pending request
// ============================================================

test("a response is matched to its pending request and not treated as an event", function () {
  var srv = makeServer();
  srv.addHandler(function () { assert.fail("a response must not reach event handlers"); });

  var resolved = null;
  srv.pendingRequests[11] = {
    resolve: function (v) { resolved = v; },
    reject: function () { assert.fail("should not reject"); },
    timer: null,
  };

  srv._handleMessage({ jsonrpc: "2.0", id: 11, result: { sessionId: "sess-a" } });

  assert.deepStrictEqual(resolved, { sessionId: "sess-a" });
  assert.strictEqual(srv.pendingRequests[11], undefined, "pending entry should be cleared");
});

test("a process request handler answers a v3 auth callback exactly once", async function () {
  var srv = makeServer();
  srv.addRequestHandler("_kiro/auth/getAccessToken", function(params) {
    assert.deepStrictEqual(params, { reason: "expired" });
    return { accessToken: "secret", expiresAt: "later" };
  });

  srv._handleMessage({
    jsonrpc: "2.0",
    id: 17,
    method: "_kiro/auth/getAccessToken",
    params: { reason: "expired" },
  });
  await new Promise(function(resolve) { setImmediate(resolve); });

  assert.strictEqual(srv.written.length, 1);
  assert.deepStrictEqual(srv.written[0], {
    jsonrpc: "2.0",
    id: 17,
    result: { accessToken: "secret", expiresAt: "later" },
  });
});
