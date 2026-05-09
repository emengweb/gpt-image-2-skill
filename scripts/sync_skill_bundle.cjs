#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "package.json"
);
const SKILL_SCRIPT = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "gpt_image_2_skill.cjs"
);
const SELFTEST_SCRIPT = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "selftest.cjs"
);
const SYNC_SCRIPT = path.join(ROOT, "scripts", "release", "sync-version-manifests.mjs");

function readVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).version;
}

function main() {
  const version = readVersion();
  fs.chmodSync(SKILL_SCRIPT, 0o755);
  fs.chmodSync(SELFTEST_SCRIPT, 0o755);
  childProcess.execFileSync(process.execPath, [SYNC_SCRIPT], {
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        updated: [SKILL_SCRIPT, SELFTEST_SCRIPT, SYNC_SCRIPT],
      },
      null,
      2
    )
  );
}

main();
