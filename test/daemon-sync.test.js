var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { attachDaemonSync } = require("../lib/daemon-sync");

function createHarness() {
  var scheduled = [];
  var cancelled = [];
  var errors = [];
  var sync = attachDaemonSync({
    intervalMs: 10000,
    setInterval: function (run, intervalMs) {
      var handle = { run: run, intervalMs: intervalMs };
      scheduled.push(handle);
      return handle;
    },
    clearInterval: function (handle) {
      cancelled.push(handle);
    },
    onError: function (key, err) {
      errors.push({ key: key, err: err });
    },
  });
  return {
    sync: sync,
    scheduled: scheduled,
    cancelled: cancelled,
    errors: errors,
  };
}

test("daemon sync shares one interval across all registered tasks", function () {
  var harness = createHarness();
  var calls = [];

  harness.sync.register("worktrees:one", function () { calls.push("one"); });
  harness.sync.register("worktrees:two", function () { calls.push("two"); });

  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.scheduled[0].intervalMs, 10000);
  assert.equal(harness.sync.getTaskCount(), 2);

  harness.scheduled[0].run();
  assert.deepEqual(calls, ["one", "two"]);

  harness.sync.unregister("worktrees:one");
  assert.equal(harness.cancelled.length, 0);
  harness.sync.unregister("worktrees:two");
  assert.equal(harness.cancelled.length, 1);
  assert.equal(harness.sync.isRunning(), false);
});

test("daemon sync replaces a task without creating another interval", function () {
  var harness = createHarness();
  var value = "";

  harness.sync.register("worktrees:one", function () { value = "old"; });
  harness.sync.register("worktrees:one", function () { value = "new"; });
  harness.sync.tick();

  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.sync.getTaskCount(), 1);
  assert.equal(value, "new");
});

test("daemon sync does not overlap an unfinished asynchronous task", async function () {
  var harness = createHarness();
  var resolveTask;
  var calls = 0;
  var pending = new Promise(function (resolve) { resolveTask = resolve; });

  harness.sync.register("issues:one", function () {
    calls++;
    return pending;
  });

  harness.sync.tick();
  harness.sync.tick();
  assert.equal(calls, 1);

  resolveTask();
  await pending;
  await Promise.resolve();
  harness.sync.tick();
  assert.equal(calls, 2);
});

test("daemon sync reports a rejection and runs the task again later", async function () {
  var harness = createHarness();
  var calls = 0;

  harness.sync.register("issues:one", function () {
    calls++;
    return Promise.reject(new Error("network failed"));
  });

  harness.sync.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0].key, "issues:one");

  harness.sync.tick();
  assert.equal(calls, 2);
});

test("daemon project scans use the shared sync loop", function () {
  var source = fs.readFileSync(path.join(__dirname, "../lib/daemon-projects.js"), "utf8");

  assert.match(source, /daemonSync\.register\(getWorktreeSyncKey\(parentSlug\)/);
  assert.match(source, /daemonSync\.unregister\(getWorktreeSyncKey\(parentSlug\)/);
  assert.doesNotMatch(source, /setInterval|worktreeTimers/);
});
