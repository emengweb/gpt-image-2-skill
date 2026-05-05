import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.ts";
import type { OutputFile } from "./types.ts";

export function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

export function writeImageOutputs(buffers: Buffer[], outPath: string) {
  if (buffers.length === 0) {
    throw new CliError("invalid_response", "接口响应里没有生成图片。");
  }
  return buffers.map((buffer, index) => writeSingleOutput(buffer, outPath, index));
}

function writeSingleOutput(buffer: Buffer, outPath: string, index: number): OutputFile {
  if (!buffer.length) {
    throw new CliError(
      "invalid_image_payload",
      "图片返回包含空的 b64_json，已阻止生成 0 字节文件。",
      { index }
    );
  }
  const targetPath = index === 0 ? outPath : appendIndex(outPath, index);
  ensureParentDir(targetPath);
  fs.writeFileSync(targetPath, buffer);
  const bytes = fs.statSync(targetPath).size;
  if (bytes === 0) {
    throw new CliError(
      "invalid_image_payload",
      "图片写出结果为 0 字节，已判定为上游返回异常。",
      { index, path: targetPath }
    );
  }
  return {
    index,
    path: targetPath,
    bytes,
  };
}

function appendIndex(filePath: string, index: number) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}-${index}${ext}`;
}
