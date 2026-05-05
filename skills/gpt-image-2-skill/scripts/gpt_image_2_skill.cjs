#!/usr/bin/env node

const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const entry = pathToFileURL(path.join(__dirname, "cli-core.ts")).href;
  const mod = await import(entry);
  const code = await mod.runCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
