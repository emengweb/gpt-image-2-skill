#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// 启动器只依赖本文件所在目录（技能自带 scripts/），与调用方 cwd 无关。
const SCRIPT_DIR = __dirname;
const ENTRY_PATH = path.join(SCRIPT_DIR, "cli-core.ts");
const REQUIRED_MODULES = ["jpeg-js", "pngjs"];
const NO_FALLBACK_NOTICE =
  "This skill always runs its own bundled launcher and never falls back to a globally installed gpt-image-2-skill CLI.";

function localInitCommand() {
  return `npm install --omit=dev --no-audit --no-fund --prefix ${JSON.stringify(SCRIPT_DIR)}`;
}

function missingModules() {
  return REQUIRED_MODULES.filter(
    (name) => !fs.existsSync(path.join(SCRIPT_DIR, "node_modules", name, "package.json")),
  );
}

function dependencyInitHints() {
  return [
    "Initialize the bundled runtime once (nothing is installed globally):",
    `  ${localInitCommand()}`,
    "If bundled files are missing, reinstall the skill instead of installing a global CLI.",
  ];
}

function fail(lines) {
  process.stderr.write(`${[...lines, NO_FALLBACK_NOTICE].join("\n")}\n`);
  process.exit(1);
}

function assertRuntimeReady() {
  const missing = missingModules();
  if (missing.length > 0) {
    fail([`Bundled runtime dependencies are missing: ${missing.join(", ")}.`, ...dependencyInitHints()]);
  }
  if (!process.features.typescript) {
    fail([
      `The bundled TypeScript runtime requires Node.js >= 22.18 (current: ${process.version}).`,
      "Upgrade Node.js and retry.",
    ]);
  }
}

async function main() {
  assertRuntimeReady();
  let mod;
  try {
    mod = await import(pathToFileURL(ENTRY_PATH).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail([`Bundled runtime failed to load: ${message}`, ...dependencyInitHints()]);
  }
  const code = await mod.runCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
