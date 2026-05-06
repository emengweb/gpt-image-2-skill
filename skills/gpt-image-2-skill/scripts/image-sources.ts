import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.ts";
import { readConfig, resolveUserAgent } from "./config-store.ts";
import { buildUserAgentHeaders } from "./request-headers.ts";

export function decodeBase64Bytes(value: string) {
  const encoded = value.startsWith("data:image/")
    ? value.split(",", 2)[1]
    : value;
  if (!encoded) {
    throw new CliError("invalid_base64", "Image payload did not contain base64 bytes.");
  }
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    throw new CliError("invalid_base64", "Image payload was not valid base64.");
  }
}

export function detectMimeType(filePath: string, bytes: Buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png" || bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg" || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (ext === ".webp" || (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")) {
    return "image/webp";
  }
  if (ext === ".gif" || bytes.subarray(0, 6).toString() === "GIF87a" || bytes.subarray(0, 6).toString() === "GIF89a") {
    return "image/gif";
  }
  throw new CliError("ref_image_invalid", `Unsupported image format: ${filePath}`);
}

export function detectExtension(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return ".webp";
  if (bytes.subarray(0, 6).toString() === "GIF87a" || bytes.subarray(0, 6).toString() === "GIF89a") return ".gif";
  return ".bin";
}

export function localPathToDataUrl(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new CliError("ref_image_missing", `Reference image not found: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  const mimeType = detectMimeType(filePath, bytes);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

export function resolveRefImage(value: string) {
  if (value.startsWith("data:image/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
    if (url.protocol === "file:") return localPathToDataUrl(url.pathname);
  } catch {
    return localPathToDataUrl(value);
  }
  return localPathToDataUrl(value);
}

export function resolveRefImages(values: string[]) {
  return values.map(resolveRefImage);
}

export async function loadImageSourceBytes(source: string, fallbackName: string) {
  if (source.startsWith("data:image/")) {
    const prefix = source.split(",", 1)[0];
    const mimeType = prefix.slice("data:".length).split(";", 1)[0] || "application/octet-stream";
    const bytes = decodeBase64Bytes(source);
    return {
      mimeType,
      bytes,
      fileName: `${fallbackName}${extensionForMimeType(mimeType)}`,
    };
  }
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const userAgent = resolveUserAgent(readConfig());
      const response = await fetch(source, {
        headers: buildUserAgentHeaders(userAgent),
      });
      if (!response.ok) {
        throw new CliError("http_error", `${response.status} ${response.statusText}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const name = path.basename(url.pathname) || fallbackName;
      const mimeType = detectMimeType(name, bytes);
      return {
        mimeType,
        bytes,
        fileName: sanitizeFileName(`${path.parse(name).name}${extensionForMimeType(mimeType)}`),
      };
    }
    if (url.protocol === "file:") {
      const filePath = decodeURIComponent(url.pathname);
      const bytes = fs.readFileSync(filePath);
      const mimeType = detectMimeType(filePath, bytes);
      return {
        mimeType,
        bytes,
        fileName: sanitizeFileName(path.basename(filePath)),
      };
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  const bytes = fs.readFileSync(source);
  const mimeType = detectMimeType(source, bytes);
  return {
    mimeType,
    bytes,
    fileName: sanitizeFileName(path.basename(source)),
  };
}

export function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

export function sanitizeFileName(name: string) {
  const clean = Array.from(name)
    .filter((character) => /[a-zA-Z0-9._-]/.test(character))
    .join("");
  return clean || "image.bin";
}
