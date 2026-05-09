#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PACKAGE_JSON = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "package.json",
);
const PACKAGE_LOCK = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "package-lock.json",
);
const SKILL_SCRIPT = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "gpt_image_2_skill.cjs",
);
const SELFTEST_SCRIPT = path.join(
  ROOT,
  "skills",
  "gpt-image-2-skill",
  "scripts",
  "selftest.cjs",
);
const APP_PACKAGE_JSON = path.join(ROOT, "apps", "gpt-image-2-app", "package.json");
const APP_PACKAGE_LOCK = path.join(ROOT, "apps", "gpt-image-2-app", "package-lock.json");

function readVersion() {
  const value = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  if (!value.version) {
    throw new Error(`Unable to determine version from ${PACKAGE_JSON}`);
  }
  return value.version;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function updateJsonVersion(filePath, version) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  value.version = version;
  writeJson(filePath, value);
}

function updatePackageLockVersion(filePath, version) {
  if (!fs.existsSync(filePath)) return;
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  value.version = version;
  if (value.packages?.[""]) {
    value.packages[""].version = version;
  }
  writeJson(filePath, value);
}

function main() {
  const version = readVersion();
  fs.chmodSync(SKILL_SCRIPT, 0o755);
  fs.chmodSync(SELFTEST_SCRIPT, 0o755);
  updatePackageLockVersion(PACKAGE_LOCK, version);
  updateJsonVersion(APP_PACKAGE_JSON, version);
  updatePackageLockVersion(APP_PACKAGE_LOCK, version);
  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        updated: [
          SKILL_SCRIPT,
          SELFTEST_SCRIPT,
          PACKAGE_LOCK,
          APP_PACKAGE_JSON,
          APP_PACKAGE_LOCK,
        ],
      },
      null,
      2,
    ),
  );
}

main();
