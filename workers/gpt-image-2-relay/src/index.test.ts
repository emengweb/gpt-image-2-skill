import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const env: Env = {
  RELAY_ENABLED: "true",
  RELAY_MODE: "open",
  RELAY_ALLOWLIST_REPORT_ONLY: "true",
  RELAY_ALLOWED_ORIGINS: "https://image.codex-pool.com",
  RELAY_ALLOWED_METHODS: "GET,POST,OPTIONS",
  RELAY_MAX_REQUEST_BYTES: "1024",
  RELAY_MAX_RESPONSE_BYTES: "1024",
};

function ctx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

describe("gpt-image-2 relay worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles CORS preflight for the static site", async () => {
    const response = await worker.fetch(
      new Request("https://image.codex-pool.com/api/relay", {
        method: "OPTIONS",
        headers: { Origin: "https://image.codex-pool.com" },
      }),
      env,
      ctx(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://image.codex-pool.com",
    );
  });

  it("streams an HTTPS upstream while stripping cookies", async () => {
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.example.com/v1/models");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "secret=1",
        },
      });
    });
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await worker.fetch(
      new Request("https://image.codex-pool.com/api/relay", {
        method: "POST",
        headers: {
          Origin: "https://image.codex-pool.com",
          "X-GPT-Image-2-Upstream": "https://api.example.com/v1/models",
          "X-GPT-Image-2-Method": "GET",
          Authorization: "Bearer sk-test",
        },
      }),
      env,
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-GPT-Image-2-Relay")).toBe("1");
  });

  it("blocks non-HTTPS and private upstreams", async () => {
    for (const upstream of [
      "http://api.example.com/v1/models",
      "https://127.0.0.1/v1/models",
      "https://192.168.1.10/v1/models",
      "https://localhost/v1/models",
    ]) {
      const response = await worker.fetch(
        new Request("https://image.codex-pool.com/api/relay", {
          method: "POST",
          headers: {
            Origin: "https://image.codex-pool.com",
            "X-GPT-Image-2-Upstream": upstream,
            "X-GPT-Image-2-Method": "GET",
          },
        }),
        env,
        ctx(),
      );

      expect(response.status).toBe(400);
    }
  });

  it("can enforce allowlist mode later", async () => {
    const response = await worker.fetch(
      new Request("https://image.codex-pool.com/api/relay", {
        method: "POST",
        headers: {
          Origin: "https://image.codex-pool.com",
          "X-GPT-Image-2-Upstream": "https://api.example.com/v1/models",
          "X-GPT-Image-2-Method": "GET",
        },
      }),
      {
        ...env,
        RELAY_MODE: "allowlist",
        RELAY_ALLOWLIST_REPORT_ONLY: "false",
        RELAY_ALLOWLIST_JSON: JSON.stringify([
          { origin: "https://api.duckcoding.com", basePath: "/v1" },
        ]),
      },
      ctx(),
    );

    expect(response.status).toBe(403);
  });
});
