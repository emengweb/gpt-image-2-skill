import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { buildGenerateBody, requestGenerate } from "./openai-client.ts";
import { JsonEventWriter } from "./json-events.ts";
import type { ProviderConfig } from "./types.ts";
import { buildCodexImageBody, runCodexImageCommand, runCodexRequestCreate } from "./codex-client.ts";
import { runTransparentVerify } from "./transparent-client.ts";
import { resolveUserAgent } from "./config-store.ts";
import { normalizeAndValidateImageSize, normalizeImageSizeInBody } from "./image-size.ts";
import { loadImageSourceBytes } from "./image-sources.ts";

const tinyPngBase64 = Buffer.from("fake-image").toString("base64");
const require = createRequire(import.meta.url);

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: "openai-compatible",
    api_base: "https://mock.example/v1",
    model: "gpt-image-2",
    supports_n: true,
    edit_region_mode: "native-mask",
    credentials: {
      api_key: { source: "file", value: "sk-test" },
    },
    ...overrides,
  };
}

function headerValue(init: RequestInit | undefined, name: string) {
  return new Headers(init?.headers).get(name);
}

function writeRgbPngWithoutAlpha(filePath: string) {
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const png = new PNG({ width: 4, height: 4, colorType: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 220;
    png.data[i + 1] = 40;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png, { colorType: 2 }));
}

function writeSolidJpeg(filePath: string) {
  const jpeg = require("jpeg-js") as typeof import("jpeg-js");
  const width = 8;
  const height = 8;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 240;
    data[i + 1] = 240;
    data[i + 2] = 240;
    data[i + 3] = 255;
  }
  fs.writeFileSync(filePath, jpeg.encode({ data, width, height }, 90).data);
}

function writeRgbaPng(filePath: string, width: number, height: number, painter: (x: number, y: number) => [number, number, number, number]) {
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const png = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b, a] = painter(x, y);
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = a;
    }
  }
  fs.writeFileSync(filePath, PNG.sync.write(png, { colorType: 6 }));
}

test("generate body defaults to response_format=b64_json and stream=false", () => {
  const body = buildGenerateBody(provider(), {
    prompt: "hello",
    out: "/tmp/out.png",
  });
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.stream, false);
});

test("generate body honors provider stream config and explicit --stream style override", () => {
  const providerStreamBody = buildGenerateBody(provider({ stream: true }), {
    prompt: "hello",
    out: "/tmp/out.png",
  });
  assert.equal(providerStreamBody.stream, true);
  const explicitBody = buildGenerateBody(provider({ stream: false }), {
    prompt: "hello",
    out: "/tmp/out.png",
    stream: true,
  });
  assert.equal(explicitBody.stream, true);
});

test("size normalization expands scalar and alias inputs", () => {
  assert.equal(normalizeAndValidateImageSize("1024"), "1024x1024");
  assert.equal(normalizeAndValidateImageSize("1K"), "1024x1024");
  assert.equal(normalizeAndValidateImageSize("2k"), "2048x2048");
  assert.equal(normalizeAndValidateImageSize("3K"), "3072x1728");
  assert.equal(normalizeAndValidateImageSize("4K"), "3840x2160");
  assert.equal(normalizeAndValidateImageSize("5K"), "2880x2880");
  assert.equal(normalizeAndValidateImageSize("5120*5120"), "2880x2880");
  assert.equal(normalizeAndValidateImageSize("5120*10240"), "1920x3840");
  assert.equal(normalizeAndValidateImageSize("1024x1536"), "1024x1536");
});

test("request body size normalization rewrites raw size shorthands", () => {
  assert.deepEqual(normalizeImageSizeInBody({ size: "1024", prompt: "hello" }).body, {
    size: "1024x1024",
    prompt: "hello",
  });
  assert.deepEqual(normalizeImageSizeInBody({ size: "2K", prompt: "hello" }).body, {
    size: "2048x2048",
    prompt: "hello",
  });
  assert.deepEqual(normalizeImageSizeInBody({ size: "3K", prompt: "hello" }).body, {
    size: "3072x1728",
    prompt: "hello",
  });
  const oversize = normalizeImageSizeInBody({ size: "5K", prompt: "hello" });
  assert.deepEqual(oversize.body, {
    size: "2880x2880",
    prompt: "hello",
  });
  assert.equal(oversize.sizeResolution?.oversize_adjusted, true);
  assert.match(oversize.sizeResolution?.message || "", /automatically reduced to 2880x2880/);
  assert.deepEqual(normalizeImageSizeInBody({ size: 1024, prompt: "hello" }).body, {
    size: "1024x1024",
    prompt: "hello",
  });
});

test("resolveUserAgent defaults to OpenAI/JS 4.96.0 and trims custom values", () => {
  assert.equal(resolveUserAgent({}), "OpenAI/JS 4.96.0");
  assert.equal(resolveUserAgent({ user_agent: "  MyApp/1.0  " }), "MyApp/1.0");
  assert.equal(resolveUserAgent({ user_agent: "   " }), "OpenAI/JS 4.96.0");
});

test("requestGenerate rejects empty b64_json instead of writing a zero-byte file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const outPath = path.join(tempDir, "out.png");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: "" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await assert.rejects(
      requestGenerate(
        provider(),
        "sk-test",
        {
          prompt: "hello",
          out: outPath,
        },
        new AbortController().signal,
        new JsonEventWriter(false),
      ),
      /空的 b64_json/,
    );
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("requestGenerate persists non-empty b64_json to a non-zero-byte file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const outPath = path.join(tempDir, "out.png");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ created: 1, data: [{ b64_json: tinyPngBase64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const result = await requestGenerate(
      provider(),
      "sk-test",
      {
        prompt: "hello",
        out: outPath,
      },
      new AbortController().signal,
      new JsonEventWriter(false),
    );
    assert.equal(result.files.length, 1);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("requestGenerate consumes OpenAI-compatible SSE image responses and passes through upstream events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const outPath = path.join(tempDir, "out-sse.png");
  const originalFetch = globalThis.fetch;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
        controller.enqueue(
          encoder.encode('event: response.created\ndata: {"created":1}\n\n'),
        );
        controller.enqueue(
          encoder.encode(
            'event: response.output_item.done\ndata: {"data":[{"b64_json":"' +
              tinyPngBase64 +
              '"}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const result = await requestGenerate(
      provider(),
      "sk-test",
      {
        prompt: "hello",
        out: outPath,
      },
      new AbortController().signal,
      new JsonEventWriter(true),
    );
    assert.equal(result.files.length, 1);
    assert.ok(fs.statSync(outPath).size > 0);
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string });
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "response.created"));
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "response.output_item.done"));
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "done"));
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("requestGenerate consumes vendor SSE partial_image/completed events with top-level b64_json", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const outPath = path.join(tempDir, "out-vendor-sse.png");
  const previewPath = path.join(tempDir, "preview-vendor-sse.png");
  const originalFetch = globalThis.fetch;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","created_at":1,"partial_image_index":0,"b64_json":"' +
              tinyPngBase64 +
              '","background":"opaque","output_format":"png","quality":"high","size":"1024x1024","model":"gpt-image-2"}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'event: image_generation.completed\ndata: {"type":"image_generation.completed","created_at":1,"b64_json":"' +
              tinyPngBase64 +
              '","background":"opaque","output_format":"png","quality":"high","size":"1024x1024","model":"gpt-image-2","usage":{"total_tokens":1}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const result = await requestGenerate(
      provider(),
      "sk-test",
      {
        prompt: "hello",
        out: outPath,
        previewOut: previewPath,
      },
      new AbortController().signal,
      new JsonEventWriter(true),
    );
    assert.equal(result.files.length, 1);
    assert.ok(fs.statSync(outPath).size > 0);
    assert.ok(fs.statSync(previewPath).size > 0);
    assert.equal(result.previewFiles?.length, 1);
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string });
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "image_generation.partial_image"));
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "image_generation.completed"));
    assert.ok(events.some((event) => event.kind === "progress" && event.type === "preview_saved"));
    assert.ok(events.some((event) => event.kind === "progress" && event.type === "output_item_done"));
    assert.ok(events.some((event) => event.kind === "progress" && event.type === "response_completed"));
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli images generate writes preview_output when --preview-out is provided", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const outPath = path.join(tempDir, "out.png");
  const previewPath = path.join(tempDir, "preview.png");
  const fetchStubPath = path.join(tempDir, "fetch-preview-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
globalThis.fetch = async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: image_generation.partial_image\\ndata: {"type":"image_generation.partial_image","created_at":1,"partial_image_index":0,"b64_json":"${tinyPngBase64}"}\\n\\n'
      ));
      controller.enqueue(encoder.encode(
        'event: image_generation.completed\\ndata: {"type":"image_generation.completed","created_at":1,"b64_json":"${tinyPngBase64}"}\\n\\n'
      ));
      controller.enqueue(encoder.encode("data: [DONE]\\n\\n"));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "images",
        "generate",
        "--prompt",
        "apple",
        "--out",
        outPath,
        "--preview-out",
        previewPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.preview_output.path, previewPath);
    assert.ok(fs.statSync(previewPath).size > 0);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("requestGenerate surfaces OpenAI-compatible SSE error payloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: error\ndata: {"error":{"message":"upstream stream failed"}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    await assert.rejects(
      requestGenerate(
        provider(),
        "sk-test",
        {
          prompt: "hello",
          out: "/tmp/out.png",
        },
        new AbortController().signal,
        new JsonEventWriter(false),
      ),
      /upstream stream failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestGenerate consumes chunked JSON responses without waiting for response.text()", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const outPath = path.join(tempDir, "out-chunked.png");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"created":1,"data":[{"b64_json":"'));
        controller.enqueue(encoder.encode(tinyPngBase64));
        controller.enqueue(encoder.encode('"}]}'));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await requestGenerate(
      provider(),
      "sk-test",
      {
        prompt: "hello",
        out: outPath,
      },
      new AbortController().signal,
      new JsonEventWriter(false),
    );
    assert.equal(result.files.length, 1);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("config inspect redacts file credentials", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          credentials: {
            api_key: { source: "file", value: "sk-secret" },
          },
        },
      },
    }),
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [cliPath, "--json", "config", "inspect"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.config.providers.mock.credentials.api_key.value,
      undefined,
    );
    assert.equal(
      payload.config.providers.mock.credentials.api_key.present,
      true,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("config set-user-agent persists a custom global user agent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const setResult = childProcess.spawnSync(
      process.execPath,
      [
        cliPath,
        "--json",
        "config",
        "set-user-agent",
        "--value",
        "MyApp/1.0",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(setResult.status, 0, setResult.stderr);

    const inspectResult = childProcess.spawnSync(
      process.execPath,
      [cliPath, "--json", "config", "inspect"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(inspectResult.status, 0, inspectResult.stderr);
    const payload = JSON.parse(inspectResult.stdout);
    assert.equal(payload.config.user_agent, "MyApp/1.0");

    const clearResult = childProcess.spawnSync(
      process.execPath,
      [cliPath, "--json", "config", "clear-user-agent"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(clearResult.status, 0, clearResult.stderr);

    const clearedInspectResult = childProcess.spawnSync(
      process.execPath,
      [cliPath, "--json", "config", "inspect"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(clearedInspectResult.status, 0, clearedInspectResult.stderr);
    const clearedPayload = JSON.parse(clearedInspectResult.stdout);
    assert.equal(clearedPayload.config.user_agent, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("requestGenerate sends the configured user agent header on OpenAI-compatible requests", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const outPath = path.join(tempDir, "out.png");
  const originalFetch = globalThis.fetch;
  const originalCodexHome = process.env.CODEX_HOME;
  const seen: Array<{ url: string; userAgent: string | null }> = [];
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      user_agent: "MyApp/2.0",
      providers: {},
    }),
  );
  globalThis.fetch = async (input, init = {}) => {
    seen.push({
      url: String(input),
      userAgent: headerValue(init, "User-Agent"),
    });
    return new Response(
      JSON.stringify({
        created: 1,
        data: [{ b64_json: tinyPngBase64 }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  process.env.CODEX_HOME = codexHome;
  try {
    const result = await requestGenerate(
      provider(),
      "sk-test",
      {
        prompt: "hello",
        out: outPath,
      },
      new AbortController().signal,
      new JsonEventWriter(false),
    );
    assert.equal(result.files.length, 1);
    assert.equal(seen[0]?.userAgent, "MyApp/2.0");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCodexImageCommand sends the configured user agent header", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const outPath = path.join(tempDir, "out.png");
  const originalFetch = globalThis.fetch;
  const originalCodexHome = process.env.CODEX_HOME;
  const seen: Array<{ url: string; userAgent: string | null }> = [];
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      user_agent: "MyApp/2.0",
      providers: {
        mock: {
          type: "codex",
          endpoint: "https://mock.example/v1/responses",
          model: "gpt-5.4",
          credentials: {
            access_token: { source: "file", value: "access-token" },
            account_id: { source: "file", value: "account-id" },
          },
        },
      },
    }),
  );
  globalThis.fetch = async (input, init = {}) => {
    seen.push({
      url: String(input),
      userAgent: headerValue(init, "User-Agent"),
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"image_generation_call","status":"completed","result":"' +
              tinyPngBase64 +
              '"}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  process.env.CODEX_HOME = codexHome;
  try {
    const result = await runCodexImageCommand({
      providerName: "mock",
      provider: {
        type: "codex",
        endpoint: "https://mock.example/v1/responses",
        model: "gpt-5.4",
        credentials: {},
      },
      command: "generate",
      prompt: "hello",
      out: outPath,
      events: new JsonEventWriter(false),
    });
    assert.equal(result.files.length, 1);
    assert.equal(seen[0]?.userAgent, "MyApp/2.0");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadImageSourceBytes sends the configured user agent header for remote sources", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const originalFetch = globalThis.fetch;
  const originalCodexHome = process.env.CODEX_HOME;
  const seen: Array<{ url: string; userAgent: string | null }> = [];
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR4nGNgoBQwwhj/wQhFAizHRMgEyhVQDgB71QIIdIAIkgAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      user_agent: "MyApp/2.0",
      providers: {},
    }),
  );
  globalThis.fetch = async (input, init = {}) => {
    seen.push({
      url: String(input),
      userAgent: headerValue(init, "User-Agent"),
    });
    return new Response(pngBytes, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  };
  process.env.CODEX_HOME = codexHome;
  try {
    const loaded = await loadImageSourceBytes("https://assets.example/ref.png", "ref");
    assert.equal(seen[0]?.userAgent, "MyApp/2.0");
    assert.equal(loaded.mimeType, "image/png");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli images generate sends response_format=b64_json and stream=false by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const captureFile = path.join(tempDir, "capture.json");
  const outPath = path.join(tempDir, "out.png");
  const fetchStubPath = path.join(tempDir, "fetch-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
const fs = require("node:fs");
const captureFile = process.env.TEST_CAPTURE_FILE;
globalThis.fetch = async (input, init = {}) => {
  fs.writeFileSync(captureFile, JSON.stringify({
    url: String(input),
    body: JSON.parse(String(init.body))
  }));
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: ${JSON.stringify(tinyPngBase64)} }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      ["--require", fetchStubPath, cliPath, "--json", "images", "generate", "--prompt", "apple", "--out", outPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.body.response_format, "b64_json");
    assert.equal(capture.body.stream, false);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli images generate sends stream=true when --stream is provided", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const captureFile = path.join(tempDir, "capture.json");
  const outPath = path.join(tempDir, "out-stream.png");
  const fetchStubPath = path.join(tempDir, "fetch-stream-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          stream: false,
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
const fs = require("node:fs");
const captureFile = process.env.TEST_CAPTURE_FILE;
globalThis.fetch = async (input, init = {}) => {
  fs.writeFileSync(captureFile, JSON.stringify({
    url: String(input),
    body: JSON.parse(String(init.body))
  }));
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: ${JSON.stringify(tinyPngBase64)} }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "images",
        "generate",
        "--stream",
        "--prompt",
        "apple",
        "--out",
        outPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.body.stream, true);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli images generate normalizes scalar and alias sizes before sending upstream", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const captureFile = path.join(tempDir, "capture.json");
  const outPath = path.join(tempDir, "out.png");
  const fetchStubPath = path.join(tempDir, "fetch-size-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
const fs = require("node:fs");
const captureFile = process.env.TEST_CAPTURE_FILE;
globalThis.fetch = async (input, init = {}) => {
  fs.writeFileSync(captureFile, JSON.stringify({
    url: String(input),
    body: JSON.parse(String(init.body))
  }));
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: ${JSON.stringify(tinyPngBase64)} }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const scalarResult = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "images",
        "generate",
        "--prompt",
        "apple",
        "--out",
        outPath,
        "--size",
        "1024",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(scalarResult.status, 0, scalarResult.stderr);
    const scalarPayload = JSON.parse(scalarResult.stdout);
    const scalarCapture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(scalarCapture.body.size, "1024x1024");
    assert.equal(scalarPayload.size_normalization.requested, "1024");
    assert.equal(scalarPayload.size_normalization.resolved, "1024x1024");

    const aliasResult = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "images",
        "generate",
        "--prompt",
        "apple",
        "--out",
        outPath,
        "--size",
        "2K",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(aliasResult.status, 0, aliasResult.stderr);
    const aliasPayload = JSON.parse(aliasResult.stdout);
    const aliasCapture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(aliasCapture.body.size, "2048x2048");
    assert.equal(aliasPayload.size_normalization.requested, "2K");
    assert.equal(aliasPayload.size_normalization.resolved, "2048x2048");

    const oversizedResult = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "images",
        "generate",
        "--prompt",
        "apple",
        "--out",
        outPath,
        "--size",
        "5K",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(oversizedResult.status, 0, oversizedResult.stderr);
    const oversizedPayload = JSON.parse(oversizedResult.stdout);
    const oversizedCapture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(oversizedCapture.body.size, "2880x2880");
    assert.equal(oversizedPayload.size_normalization.requested, "5K");
    assert.equal(oversizedPayload.size_normalization.resolved, "2880x2880");
    assert.equal(oversizedPayload.size_normalization.oversize_adjusted, true);
    assert.match(oversizedPayload.size_normalization.message, /automatically reduced to 2880x2880/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli images generate falls back to default provider when requested provider is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const captureFile = path.join(tempDir, "capture.json");
  const outPath = path.join(tempDir, "out.png");
  const fetchStubPath = path.join(tempDir, "fetch-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
const fs = require("node:fs");
const captureFile = process.env.TEST_CAPTURE_FILE;
globalThis.fetch = async (input, init = {}) => {
  fs.writeFileSync(captureFile, JSON.stringify({
    url: String(input),
    body: JSON.parse(String(init.body))
  }));
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: ${JSON.stringify(tinyPngBase64)} }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "images",
        "generate",
        "--provider",
        "missing-provider",
        "--prompt",
        "apple",
        "--out",
        outPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.provider_selection.requested, "missing-provider");
    assert.equal(payload.provider_selection.resolved, "mock");
    assert.equal(
      payload.provider_selection.reason,
      "requested_provider_missing_fallback_default",
    );
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.url, "https://mock.example/v1/images/generations");
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("config add-provider persists sanitized provider config", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        cliPath,
        "--json",
        "config",
        "add-provider",
        "--name",
        "mock2",
        "--type",
        "openai-compatible",
        "--api-base",
        "https://mock.example/v1",
        "--api-key",
        "sk-secret",
        "--stream",
        "--set-default",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "config add-provider");
    assert.equal(payload.provider, "mock2");
    assert.equal(payload.config.default_provider, "mock2");
    assert.equal(payload.config.providers.mock2.stream, true);
    assert.equal(payload.config.providers.mock2.credentials.api_key.present, true);
    assert.equal(payload.config.providers.mock2.credentials.api_key.value, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("request create generate writes image output from raw body", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const captureFile = path.join(tempDir, "capture.json");
  const outPath = path.join(tempDir, "req-out.png");
  const bodyFile = path.join(tempDir, "body.json");
  const fetchStubPath = path.join(tempDir, "fetch-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    bodyFile,
    JSON.stringify({ model: "gpt-image-2", prompt: "apple", size: "5120*5120" }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
const fs = require("node:fs");
globalThis.fetch = async (input, init = {}) => {
  fs.writeFileSync(process.env.TEST_CAPTURE_FILE, JSON.stringify({
    url: String(input),
    body: JSON.parse(String(init.body))
  }));
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: ${JSON.stringify(tinyPngBase64)} }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "request",
        "create",
        "--request-operation",
        "generate",
        "--body-file",
        bodyFile,
        "--out-image",
        outPath,
        "--expect-image",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "request create");
    assert.equal(payload.request.operation, "generate");
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.body.size, "2880x2880");
    assert.equal(payload.size_normalization.requested, "5120*5120");
    assert.equal(payload.size_normalization.resolved, "2880x2880");
    assert.equal(payload.size_normalization.oversize_adjusted, true);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("global --provider is honored by request create", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const captureFile = path.join(tempDir, "capture.json");
  const outPath = path.join(tempDir, "req-provider-out.png");
  const bodyFile = path.join(tempDir, "body.json");
  const fetchStubPath = path.join(tempDir, "fetch-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "default-provider",
      providers: {
        "default-provider": {
          type: "openai-compatible",
          api_base: "https://default.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-default" },
          },
        },
        "custom-provider-id": {
          type: "openai-compatible",
          api_base: "https://custom.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-custom" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(bodyFile, JSON.stringify({ model: "gpt-image-2", prompt: "apple" }));
  fs.writeFileSync(
    fetchStubPath,
    `
const fs = require("node:fs");
globalThis.fetch = async (input, init = {}) => {
  fs.writeFileSync(process.env.TEST_CAPTURE_FILE, JSON.stringify({
    url: String(input),
    body: JSON.parse(String(init.body))
  }));
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: ${JSON.stringify(tinyPngBase64)} }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "--provider",
        "custom-provider-id",
        "request",
        "create",
        "--request-operation",
        "generate",
        "--body-file",
        bodyFile,
        "--out-image",
        outPath,
        "--expect-image",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEST_CAPTURE_FILE: captureFile,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(payload.provider, "custom-provider-id");
    assert.equal(payload.provider_selection.requested, "custom-provider-id");
    assert.equal(payload.provider_selection.resolved, "custom-provider-id");
    assert.equal(capture.url, "https://custom.example/v1/images/generations");
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("transparent extract chroma outputs verified png", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "source.png");
  const outPath = path.join(tempDir, "asset.png");
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR4nGNgoBQwwhj/wQhFAizHRMgEyhVQDgB71QIIdIAIkgAAAABJRU5ErkJggg==";
  fs.writeFileSync(inputPath, Buffer.from(pngBase64, "base64"));
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        cliPath,
        "--json",
        "transparent",
        "extract",
        "--method",
        "chroma",
        "--input",
        inputPath,
        "--out",
        outPath,
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "transparent extract");
    assert.equal(payload.verification.passed, true);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("transparent generate produces a verified png through the local pipeline", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const configDir = path.join(codexHome, "gpt-image-2-skill");
  const outPath = path.join(tempDir, "transparent.png");
  const fetchStubPath = path.join(tempDir, "fetch-stub.cjs");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      default_provider: "mock",
      providers: {
        mock: {
          type: "openai-compatible",
          api_base: "https://mock.example/v1",
          model: "gpt-image-2",
          supports_n: true,
          credentials: {
            api_key: { source: "file", value: "sk-test" },
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    fetchStubPath,
    `
globalThis.fetch = async () => new Response(JSON.stringify({
  created: 1,
  data: [{ b64_json: ${JSON.stringify(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR4nGNgoBQwwhj/wQhFAizHRMgEyhVQDgB71QIIdIAIkgAAAABJRU5ErkJggg==",
  )} }]
}), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});
`,
  );
  try {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "--require",
        fetchStubPath,
        cliPath,
        "--json",
        "transparent",
        "generate",
        "--prompt",
        "tiny icon",
        "--out",
        outPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "transparent generate");
    assert.equal(payload.verification.passed, true);
    assert.ok(fs.statSync(outPath).size > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildCodexImageBody defaults stream=false and image_generation tool", () => {
  const body = buildCodexImageBody({
    prompt: "codex apple",
    model: "gpt-5.4",
    instructions: "You are a concise assistant.",
    refImages: [],
    background: "auto",
    action: "generate",
  });
  assert.equal(body.stream, false);
  assert.equal(Array.isArray(body.tools), true);
  assert.equal((body.tools[0] as { type: string }).type, "image_generation");
});

test("buildCodexImageBody honors explicit stream=true", () => {
  const body = buildCodexImageBody({
    prompt: "codex apple",
    model: "gpt-5.4",
    instructions: "You are a concise assistant.",
    refImages: [],
    background: "auto",
    stream: true,
    action: "generate",
  });
  assert.equal(body.stream, true);
  assert.equal(Array.isArray(body.tools), true);
  assert.equal((body.tools[0] as { type: string }).type, "image_generation");
});

test("transparent verify reports matte residue warning without expected matte and aligns core quality fields", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "soft.png");
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR4nGNgoBQwwhj/wQhFAizHRMgEyhVQDgB71QIIdIAIkgAAAABJRU5ErkJggg==";
  fs.writeFileSync(inputPath, Buffer.from(pngBase64, "base64"));
  try {
    const payload = await runTransparentVerify({
      input: inputPath,
      profile: "icon",
      strict: false,
    });
    assert.equal(payload.verification.profile, "icon");
    assert.equal(typeof payload.verification.transparent_pixels, "number");
    assert.equal(typeof payload.verification.nontransparent_pixels, "number");
    assert.equal(typeof payload.verification.quality_score, "number");
    assert.equal(typeof payload.verification.alpha_health_score, "number");
    assert.equal(typeof payload.verification.residue_score, "number");
    assert.equal(payload.verification.matte_residue_checked, false);
    assert.equal(Array.isArray(payload.verification.failure_reasons), true);
    assert.equal(Array.isArray(payload.verification.warnings), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("transparent verify on JPEG returns structured failed verification instead of decode crash", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "opaque.jpg");
  writeSolidJpeg(inputPath);
  try {
    const payload = await runTransparentVerify({
      input: inputPath,
      profile: "generic",
      strict: false,
    });
    assert.equal(payload.verification.is_png, false);
    assert.equal(payload.verification.has_alpha, false);
    assert.equal(payload.verification.input_has_alpha, false);
    assert.equal(payload.verification.passed, false);
    assert.ok(payload.verification.failure_reasons.includes("not_png"));
    assert.ok(payload.verification.failure_reasons.includes("missing_alpha_channel"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("transparent verify on RGB PNG without alpha returns missing_alpha_channel semantics", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "rgb.png");
  writeRgbPngWithoutAlpha(inputPath);
  try {
    const payload = await runTransparentVerify({
      input: inputPath,
      profile: "generic",
      strict: false,
    });
    assert.equal(payload.verification.is_png, true);
    assert.equal(payload.verification.has_alpha, false);
    assert.equal(payload.verification.input_has_alpha, false);
    assert.equal(payload.verification.passed, false);
    assert.ok(payload.verification.failure_reasons.includes("missing_alpha_channel"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("seal profile allows split components while sticker profile rejects excessive stray pixels", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "seal-ish.png");
  writeRgbaPng(inputPath, 80, 80, (x, y) => {
    if ((x >= 18 && x < 30 && y >= 18 && y < 62) || (x >= 50 && x < 62 && y >= 18 && y < 62)) {
      return [200, 20, 20, 255];
    }
    return [0, 0, 0, 0];
  });
  try {
    const sticker = await runTransparentVerify({ input: inputPath, profile: "sticker", strict: false });
    const seal = await runTransparentVerify({ input: inputPath, profile: "seal", strict: false });
    assert.equal(sticker.verification.passed, false);
    assert.ok(sticker.verification.failure_reasons.includes("too_many_stray_pixels"));
    assert.equal(seal.verification.passed, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shadow profile rejects hard alpha while effect profile accepts hard alpha particles", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "particles.png");
  writeRgbaPng(inputPath, 80, 80, (x, y) => {
    for (const [cx, cy] of [
      [24, 24],
      [40, 36],
      [56, 52],
    ]) {
      if (x >= cx - 4 && x <= cx + 4 && y >= cy - 4 && y <= cy + 4) {
        return [255, 220, 80, 255];
      }
    }
    return [0, 0, 0, 0];
  });
  try {
    const shadow = await runTransparentVerify({ input: inputPath, profile: "shadow", strict: false });
    const effect = await runTransparentVerify({ input: inputPath, profile: "effect", strict: false });
    assert.equal(shadow.verification.passed, false);
    assert.ok(shadow.verification.failure_reasons.includes("profile_requires_partial_alpha"));
    assert.equal(effect.verification.passed, true);
    assert.equal(effect.verification.partial_pixels, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("glow profile requires partial alpha and transparent margin", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const inputPath = path.join(tempDir, "touching-glow.png");
  writeRgbaPng(inputPath, 64, 64, (x, y) => {
    if (x < 20 && y >= 8 && y < 56) {
      return [255, 180, 60, 180];
    }
    return [0, 0, 0, 0];
  });
  try {
    const glow = await runTransparentVerify({ input: inputPath, profile: "glow", strict: false });
    assert.equal(glow.verification.passed, false);
    assert.ok(glow.verification.failure_reasons.includes("effect_touches_edge"));
    assert.ok(glow.verification.partial_pixels > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("checkerboard detection stays below threshold for noisy grid but trips for clean high-contrast grid", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const cleanPath = path.join(tempDir, "clean-grid.jpg");
  const noisyPath = path.join(tempDir, "noisy-grid.jpg");
  const jpegLib = require("jpeg-js") as typeof import("jpeg-js");
  const buildJpeg = (filePath: string, noisy: boolean) => {
    const width = 64;
    const height = 64;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const base = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 238 : 196;
        const value = noisy
          ? Math.max(
              0,
              Math.min(
                255,
                ((x * 13 + y * 7) % 3 === 0 ? 150 : (x * 11 + y * 5) % 3 === 1 ? 215 : 245) +
                  (((x * 19 + y * 23) % 21) - 10),
              ),
            )
          : base;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
      }
    }
    fs.writeFileSync(filePath, jpegLib.encode({ data, width, height }, 90).data);
  };
  buildJpeg(cleanPath, false);
  buildJpeg(noisyPath, true);
  try {
    const clean = await runTransparentVerify({ input: cleanPath, profile: "generic", strict: false });
    const noisy = await runTransparentVerify({ input: noisyPath, profile: "generic", strict: false });
    assert.equal(clean.verification.checkerboard_detected, true);
    assert.equal(noisy.verification.checkerboard_detected, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("halo score is meaningfully higher for bright fringe than for saturated colored semi-transparent edge", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const haloPath = path.join(tempDir, "halo.png");
  const coloredPath = path.join(tempDir, "colored.png");
  const buildEdgeAsset = (filePath: string, edgeColor: [number, number, number]) => {
    writeRgbaPng(filePath, 64, 64, (x, y) => {
      if (x >= 18 && x < 46 && y >= 18 && y < 46) {
        const onEdge = x === 18 || x === 45 || y === 18 || y === 45;
        if (onEdge) return [edgeColor[0], edgeColor[1], edgeColor[2], 128];
        return [220, 20, 20, 255];
      }
      return [0, 0, 0, 0];
    });
  };
  buildEdgeAsset(haloPath, [250, 250, 250]);
  buildEdgeAsset(coloredPath, [255, 60, 40]);
  try {
    const halo = await runTransparentVerify({
      input: haloPath,
      profile: "icon",
      expectedMatteColor: "#00ff00",
      strict: false,
    });
    const colored = await runTransparentVerify({
      input: coloredPath,
      profile: "icon",
      expectedMatteColor: "#00ff00",
      strict: false,
    });
    assert.ok(halo.verification.halo_score > colored.verification.halo_score);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("matte residue score rises near threshold for expected-matte contamination and stays lower after cleanup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const contaminatedPath = path.join(tempDir, "contaminated.png");
  const cleanedPath = path.join(tempDir, "cleaned.png");
  const matte = "#00ff00";
  const buildResidueAsset = (filePath: string, greenEdge: number) => {
    writeRgbaPng(filePath, 64, 64, (x, y) => {
      if (x >= 18 && x < 46 && y >= 18 && y < 46) {
        const onEdge = x === 18 || x === 45 || y === 18 || y === 45;
        if (onEdge) return [40, greenEdge, 40, 120];
        return [220, 20, 20, 255];
      }
      return [0, 0, 0, 0];
    });
  };
  buildResidueAsset(contaminatedPath, 190);
  buildResidueAsset(cleanedPath, 90);
  try {
    const contaminated = await runTransparentVerify({
      input: contaminatedPath,
      profile: "icon",
      expectedMatteColor: matte,
      strict: false,
    });
    const cleaned = await runTransparentVerify({
      input: cleanedPath,
      profile: "icon",
      expectedMatteColor: matte,
      strict: false,
    });
    assert.ok((contaminated.verification.matte_residue_score ?? 0) > (cleaned.verification.matte_residue_score ?? 0));
    assert.ok((contaminated.verification.matte_residue_score ?? 0) > 0.12);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCodexRequestCreate emits aligned SSE and progress events for a successful streamed image response", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const outPath = path.join(tempDir, "codex.png");
  const authPath = path.join(tempDir, "auth.json");
  const eventsPath = path.join(tempDir, "events.jsonl");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      access_token: "token",
      refresh_token: "refresh",
      account_id: "acct",
    }),
  );
  const originalCodeXHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempDir;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const lines = [
          'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}\n\n',
          'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"image_generation_call","status":"completed","result":"' +
            tinyPngBase64 +
            '"}}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4"}}\n\n',
          "data: [DONE]\n\n",
        ];
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const result = await runCodexRequestCreate({
      providerName: "codex",
      provider: { type: "codex", credentials: {}, endpoint: "https://chatgpt.com/backend-api/codex/responses" },
      body: {
        model: "gpt-5.4",
        stream: true,
        input: [],
        tools: [{ type: "image_generation" }],
      },
      outImage: outPath,
      expectImage: true,
      events: new JsonEventWriter(true),
    });
    fs.writeFileSync(eventsPath, captured.join(""), "utf8");
    assert.ok(fs.statSync(outPath).size > 0);
    assert.equal(result.imageOutput?.path, outPath);
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string; data: Record<string, unknown> });
    assert.deepEqual(
      events.map((event) => `${event.kind}:${event.type}`),
      [
        "local:request.started",
        "progress:request_started",
        "sse:response.created",
        "progress:response_created",
        "sse:response.output_item.done",
        "progress:output_item_done",
        "sse:response.completed",
        "progress:response_completed",
        "sse:done",
        "progress:request_completed",
        "progress:output_saved",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    if (originalCodeXHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodeXHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCodexRequestCreate refreshes once on 401 and emits refresh events before retry", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const authPath = path.join(tempDir, "auth.json");
  const outPath = path.join(tempDir, "codex-refresh.png");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      access_token: "expired-token",
      refresh_token: "refresh-token",
      account_id: "acct",
    }),
  );
  const originalCodeXHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempDir;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (input) => {
    callCount += 1;
    if (String(input).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fresh-token", refresh_token: "refresh-token", account_id: "acct" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (callCount === 1) {
      return new Response("unauthorized", { status: 401 });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"image_generation_call","status":"completed","result":"' +
              tinyPngBase64 +
              '"}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode('data: {"type":"response.completed","response":{"id":"resp_refresh","model":"gpt-5.4"}}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const result = await runCodexRequestCreate({
      providerName: "codex",
      provider: { type: "codex", credentials: {}, endpoint: "https://chatgpt.com/backend-api/codex/responses" },
      body: {
        model: "gpt-5.4",
        stream: true,
        input: [],
        tools: [{ type: "image_generation" }],
      },
      outImage: outPath,
      expectImage: true,
      events: new JsonEventWriter(true),
    });
    assert.ok(fs.statSync(outPath).size > 0);
    assert.equal(result.outcome.refreshed, true);
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string });
    const refreshStartIndex = events.findIndex((event) => event.type === "auth_refresh_started");
    const refreshDoneIndex = events.findIndex((event) => event.type === "auth_refresh_completed");
    const secondRequestIndex = events.findIndex(
      (event, index) => index > refreshDoneIndex && event.type === "request_started",
    );
    assert.ok(refreshStartIndex >= 0);
    assert.ok(refreshDoneIndex > refreshStartIndex);
    assert.ok(secondRequestIndex > refreshDoneIndex);
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    if (originalCodeXHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodeXHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCodexRequestCreate emits request_failed for response.failed and returns structured failure without image output", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const authPath = path.join(tempDir, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      access_token: "token",
      refresh_token: "refresh",
      account_id: "acct",
    }),
  );
  const originalCodeXHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempDir;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.failed","response":{"id":"resp_fail","error":{"code":"server_error","message":"model exploded"}}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    await assert.rejects(
      runCodexRequestCreate({
        providerName: "codex",
        provider: { type: "codex", credentials: {}, endpoint: "https://chatgpt.com/backend-api/codex/responses" },
        body: { model: "gpt-5.4", stream: true, input: [], tools: [{ type: "image_generation" }] },
        expectImage: true,
        events: new JsonEventWriter(true),
      }),
      /model exploded/,
    );
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string });
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "response.failed"));
    assert.ok(events.some((event) => event.kind === "progress" && event.type === "request_failed"));
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    if (originalCodeXHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodeXHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCodexRequestCreate emits request_failed for raw error SSE before retry_scheduled on retryable failure", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const authPath = path.join(tempDir, "auth.json");
  const outPath = path.join(tempDir, "codex-retry.png");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      access_token: "token",
      refresh_token: "refresh",
      account_id: "acct",
    }),
  );
  const originalCodeXHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempDir;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (attempt === 1) {
          controller.enqueue(
            encoder.encode('data: {"type":"error","error":{"code":"server_error","message":"temporary upstream error"}}\n\n'),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } else {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"image_generation_call","status":"completed","result":"' +
                tinyPngBase64 +
                '"}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode('data: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5.4"}}\n\n'),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: any[]) => void) => {
    fn();
    return 0;
  }) as typeof setTimeout;
  try {
    const result = await runCodexRequestCreate({
      providerName: "codex",
      provider: { type: "codex", credentials: {}, endpoint: "https://chatgpt.com/backend-api/codex/responses" },
      body: { model: "gpt-5.4", stream: true, input: [], tools: [{ type: "image_generation" }] },
      outImage: outPath,
      expectImage: true,
      events: new JsonEventWriter(true),
    });
    assert.ok(fs.statSync(outPath).size > 0);
    assert.equal(result.outcome.retryCount, 1);
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string });
    const failedIndex = events.findIndex((event) => event.kind === "progress" && event.type === "request_failed");
    const retryIndex = events.findIndex((event) => event.kind === "progress" && event.type === "retry_scheduled");
    assert.ok(failedIndex >= 0);
    assert.ok(retryIndex > failedIndex);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    process.stderr.write = originalStderrWrite;
    if (originalCodeXHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodeXHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCodexRequestCreate passes through response.in_progress, response.output_item.added, and keepalive SSE events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const authPath = path.join(tempDir, "auth.json");
  const outPath = path.join(tempDir, "codex-sse.png");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      access_token: "token",
      refresh_token: "refresh",
      account_id: "acct",
    }),
  );
  const originalCodeXHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempDir;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.in_progress","response":{"id":"resp_stream"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_item.added","item":{"id":"item_partial","type":"image_generation_call","status":"in_progress"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"keepalive"}\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.done","item":{"id":"item_partial","type":"image_generation_call","status":"completed","result":"' +
              tinyPngBase64 +
              '"}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-5.4"}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    await runCodexRequestCreate({
      providerName: "codex",
      provider: { type: "codex", credentials: {}, endpoint: "https://chatgpt.com/backend-api/codex/responses" },
      body: { model: "gpt-5.4", stream: true, input: [], tools: [{ type: "image_generation" }] },
      outImage: outPath,
      expectImage: true,
      events: new JsonEventWriter(true),
    });
    const events = captured
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; type: string });
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "response.in_progress"));
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "response.output_item.added"));
    assert.ok(events.some((event) => event.kind === "sse" && event.type === "keepalive"));
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    if (originalCodeXHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodeXHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
