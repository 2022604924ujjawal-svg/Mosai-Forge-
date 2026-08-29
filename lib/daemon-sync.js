/**
 * Shared daemon synchronization loop.
 *
 * Periodic daemon work registers here so every project shares one timer.
 */

function attachDaemonSync(ctx) {
  var intervalMs = ctx.intervalMs || 10000;
  var scheduleInterval = ctx.setInterval || setInterval;
  var cancelInterval = ctx.clearInterval || clearInterval;
  var onError = ctx.onError || function (key, err) {
    console.error("[daemon] Sync task failed:", key, err);
  };
  var tasks = {};
  var timer = null;

  function finishTask(task) {
    task.running = false;
  }

  function runTask(key, task) {
    if (task.running) return;
    task.running = true;
    var result;
    try {
      result = task.run();
    } catch (err) {
      finishTask(task);
      onError(key, err);
      return;
    }
    if (result && typeof result.then === "function") {
      Promise.resolve(result).then(function () {
        finishTask(task);
      }, function (err) {
        finishTask(task);
        onError(key, err);
      });
      return;
    }
    finishTask(task);
  }

  function tick() {
    var keys = Object.keys(tasks);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var task = tasks[key];
      if (task) runTask(key, task);
    }
  }

  function start() {
    if (timer || Object.keys(tasks).length === 0) return;
    timer = scheduleInterval(tick, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function register(key, run) {
    var current = tasks[key];
    if (current) {
      current.run = run;
    } else {
      tasks[key] = { run: run, running: false };
    }
    start();
  }

  function unregister(key) {
    delete tasks[key];
    if (Object.keys(tasks).length === 0 && timer) {
      cancelInterval(timer);
      timer = null;
    }
  }

  function stop() {
    if (timer) cancelInterval(timer);
    timer = null;
    tasks = {};
  }

  function getTaskCount() {
    return Object.keys(tasks).length;
  }

  function isRunning() {
    return !!timer;
  }

  return {
    register: register,
    unregister: unregister,
    tick: tick,
    stop: stop,
    getTaskCount: getTaskCount,
    isRunning: isRunning,
  };
}

var daemonSync = attachDaemonSync({});

module.exports = {
  attachDaemonSync: attachDaemonSync,
  daemonSync: daemonSync,
};
