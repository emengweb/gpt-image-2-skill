type RelayMode = "open" | "allowlist";

export interface Env {
  RELAY_ENABLED?: string;
  RELAY_MODE?: string;
  RELAY_ALLOWLIST_REPORT_ONLY?: string;
  RELAY_ALLOWED_ORIGINS?: string;
  RELAY_ALLOWED_METHODS?: string;
  RELAY_MAX_REQUEST_BYTES?: string;
  RELAY_MAX_RESPONSE_BYTES?: string;
  RELAY_ALLOWLIST_JSON?: string;
}

type AllowlistEntry = {
  name?: string;
  origin: string;
  basePath?: string;
  paths?: string[];
  methods?: string[];
};

const RELAY_HEADER = "x-gpt-image-2-upstream";
const RELAY_METHOD_HEADER = "x-gpt-image-2-method";
const DEFAULT_ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
const DEFAULT_ALLOWED_ORIGINS = [
  "https://image.codex-pool.com",
  "https://gpt-image-2-dpm.pages.dev",
];
const DEFAULT_MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 120 * 1024 * 1024;

const REQUEST_HEADER_BLOCKLIST = new Set([
  "accept-encoding",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "connection",
  "cookie",
  "host",
  "origin",
  "referer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const RESPONSE_HEADER_BLOCKLIST = new Set([
  "connection",
  "content-length",
  "set-cookie",
  "transfer-encoding",
]);

function csv(value: string | undefined, fallback: string[]) {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function boolEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function relayMode(env: Env): RelayMode {
  return env.RELAY_MODE === "allowlist" ? "allowlist" : "open";
}

function allowedOrigins(env: Env) {
  return csv(env.RELAY_ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS);
}

function allowedMethods(env: Env) {
  return csv(env.RELAY_ALLOWED_METHODS, DEFAULT_ALLOWED_METHODS).map((method) =>
    method.toUpperCase(),
  );
}

function jsonResponse(
  status: number,
  message: string,
  request: Request,
  env: Env,
) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
    },
  });
}

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const allowOrigin =
    origin && (allowed.includes("*") || allowed.includes(origin))
      ? origin
      : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": allowedMethods(env).join(", "),
    "Access-Control-Allow-Headers":
      "authorization,content-type,accept,x-gpt-image-2-upstream,x-gpt-image-2-method",
    "Access-Control-Expose-Headers":
      "content-type,x-gpt-image-2-relay,x-gpt-image-2-relay-policy",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes("*") || allowed.includes(origin);
}

function parseAllowlist(env: Env): AllowlistEntry[] {
  if (!env.RELAY_ALLOWLIST_JSON?.trim()) return [];
  try {
    const parsed = JSON.parse(env.RELAY_ALLOWLIST_JSON) as AllowlistEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function matchAllowlistEntry(
  upstream: URL,
  method: string,
  entry: AllowlistEntry,
) {
  let origin: URL;
  try {
    origin = new URL(entry.origin);
  } catch {
    return false;
  }
  if (origin.origin !== upstream.origin) return false;
  if (entry.basePath && !upstream.pathname.startsWith(entry.basePath)) {
    return false;
  }
  if (entry.paths && !entry.paths.includes(upstream.pathname)) return false;
  if (
    entry.methods &&
    !entry.methods.map((item) => item.toUpperCase()).includes(method)
  ) {
    return false;
  }
  return true;
}

function allowlistDecision(upstream: URL, method: string, env: Env) {
  const entries = parseAllowlist(env);
  return entries.some((entry) => matchAllowlistEntry(upstream, method, entry));
}

function parseIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => Number(part));
  if (
    bytes.some(
      (byte, index) =>
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255 ||
        String(byte) !== parts[index],
    )
  ) {
    return undefined;
  }
  return bytes;
}

function privateIpv4(bytes: number[]) {
  const [a, b] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function validateUpstream(raw: string | null) {
  if (!raw?.trim()) return "Missing x-gpt-image-2-upstream.";
  let upstream: URL;
  try {
    upstream = new URL(raw);
  } catch {
    return "Invalid upstream URL.";
  }
  if (upstream.protocol !== "https:")
    return "Only HTTPS upstreams are allowed.";
  if (upstream.username || upstream.password) {
    return "Upstream URLs must not include credentials.";
  }
  if (upstream.port && upstream.port !== "443") {
    return "Only the default HTTPS port is allowed.";
  }
  const hostname = upstream.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return "Local upstreams are not allowed.";
  }
  if (hostname.includes(":")) return "IPv6 literal upstreams are not allowed.";
  const ipv4 = parseIpv4(hostname);
  if (ipv4 && privateIpv4(ipv4)) {
    return "Private network upstreams are not allowed.";
  }
  return upstream;
}

function validateContentLength(request: Request, env: Env) {
  const max = numberEnv(env.RELAY_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES);
  const header = request.headers.get("Content-Length");
  if (!header) return undefined;
  const length = Number(header);
  if (Number.isFinite(length) && length > max) {
    return `Relay request is too large. Limit is ${max} bytes.`;
  }
  return undefined;
}

function requestHeadersForUpstream(request: Request) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (REQUEST_HEADER_BLOCKLIST.has(normalized)) return;
    if (normalized.startsWith("x-gpt-image-2-")) return;
    headers.set(key, value);
  });
  return headers;
}

function responseHeadersForBrowser(
  response: Response,
  request: Request,
  env: Env,
  policy: RelayMode,
) {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (RESPONSE_HEADER_BLOCKLIST.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => {
    headers.set(key, value);
  });
  headers.set("Cache-Control", "no-store");
  headers.set("X-GPT-Image-2-Relay", "1");
  headers.set("X-GPT-Image-2-Relay-Policy", policy);
  return headers;
}

function limitResponseBody(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("relay response too large");
        controller.error(new Error("Relay response exceeded size limit."));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function handleRelay(request: Request, env: Env) {
  if (!boolEnv(env.RELAY_ENABLED, true)) {
    return jsonResponse(503, "Relay is disabled.", request, env);
  }
  if (!originAllowed(request, env)) {
    return jsonResponse(403, "Origin is not allowed.", request, env);
  }

  const method =
    request.headers.get(RELAY_METHOD_HEADER)?.trim().toUpperCase() ||
    request.method.toUpperCase();
  if (!allowedMethods(env).includes(method)) {
    return jsonResponse(405, "Method is not allowed.", request, env);
  }

  const upstreamResult = validateUpstream(request.headers.get(RELAY_HEADER));
  if (typeof upstreamResult === "string") {
    return jsonResponse(400, upstreamResult, request, env);
  }
  const upstream = upstreamResult;
  const requestSizeError = validateContentLength(request, env);
  if (requestSizeError)
    return jsonResponse(413, requestSizeError, request, env);

  const mode = relayMode(env);
  const allowlisted = allowlistDecision(upstream, method, env);
  const reportOnly = boolEnv(env.RELAY_ALLOWLIST_REPORT_ONLY, true);
  if (mode === "allowlist" && !allowlisted && !reportOnly) {
    return jsonResponse(403, "Upstream is not allowlisted.", request, env);
  }

  const responseMax = numberEnv(
    env.RELAY_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const upstreamContentLength = Number(
    request.headers.get("X-GPT-Image-2-Expected-Response-Bytes") || NaN,
  );
  if (
    Number.isFinite(upstreamContentLength) &&
    upstreamContentLength > responseMax
  ) {
    return jsonResponse(
      413,
      `Relay response is too large. Limit is ${responseMax} bytes.`,
      request,
      env,
    );
  }

  const body = method === "GET" || method === "HEAD" ? undefined : request.body;
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream, {
      method,
      headers: requestHeadersForUpstream(request),
      body,
      redirect: "manual",
    });
  } catch {
    return jsonResponse(502, "Upstream request failed.", request, env);
  }

  const contentLength = Number(upstreamResponse.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > responseMax) {
    upstreamResponse.body?.cancel("relay response too large");
    return jsonResponse(
      413,
      `Relay response is too large. Limit is ${responseMax} bytes.`,
      request,
      env,
    );
  }

  return new Response(
    upstreamResponse.body
      ? limitResponseBody(upstreamResponse.body, responseMax)
      : null,
    {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeadersForBrowser(upstreamResponse, request, env, mode),
    },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method.toUpperCase() === "OPTIONS") {
      if (!originAllowed(request, env)) {
        return jsonResponse(403, "Origin is not allowed.", request, env);
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }
    return handleRelay(request, env);
  },
};
