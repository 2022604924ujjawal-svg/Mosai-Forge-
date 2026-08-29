#!/usr/bin/env node

console.warn("\x1b[33m⚠  'claude-relay' is deprecated and will be removed in a future version.\x1b[0m");
console.warn("\x1b[33m   Use \x1b[1mnpx clay-server\x1b[22m instead.\x1b[0m\n");

require("./cli.js");
