#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const version = arg("version");
const tag = arg("tag", version ? `v${version}` : "");
const repo = arg("repo", process.env.GITHUB_REPOSITORY ?? "");
const sigDir = arg("sig-dir");
const out = arg("out", "latest.json");
const pubDate = arg("pub-date", new Date().toISOString());
const notes = arg("notes", `GPT Image 2 ${tag}`);

if (!version || !tag || !repo || !sigDir) {
  console.error(
    "Usage: generate-tauri-updater-manifest.mjs --version <x.y.z> --tag <vX.Y.Z> --repo <owner/repo> --sig-dir <dir> [--out latest.json]",
  );
  process.exit(1);
}

const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
const assets = {
  "darwin-aarch64": `GPT.Image.2_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `GPT.Image.2_${version}_x64.app.tar.gz`,
  "linux-x86_64": `GPT.Image.2_${version}_amd64.AppImage`,
  "windows-x86_64": `GPT.Image.2_${version}_x64-setup.exe`,
};

const platforms = {};
for (const [platform, asset] of Object.entries(assets)) {
  const sigPath = path.join(sigDir, `${asset}.sig`);
  if (!existsSync(sigPath)) {
    console.error(`Missing updater signature for ${platform}: ${sigPath}`);
    process.exit(1);
  }
  platforms[platform] = {
    signature: readFileSync(sigPath, "utf8").trim(),
    url: `${baseUrl}/${encodeURIComponent(asset)}`,
  };
}

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}`);
