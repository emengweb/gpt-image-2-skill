# Global User-Agent Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global `user_agent` config that defaults to `OpenAI/Python 1.61.1` and is sent on all skill-managed HTTP requests.

**Architecture:** Keep the setting at the top-level shared config so every provider shares one value. Resolve it once in config utilities, then thread the resolved UA into the small set of fetch call sites through a shared request-header helper. Keep config commands, request code, and tests separated so the behavior is easy to reason about.

**Tech Stack:** TypeScript, Node `fetch`, existing CLI/config utilities, node:test.

---

### Task 1: Add global config plumbing and CLI commands

**Files:**
- Modify: `skills/gpt-image-2-skill/scripts/types.ts`
- Modify: `skills/gpt-image-2-skill/scripts/config-store.ts`
- Modify: `skills/gpt-image-2-skill/scripts/cli-core.ts`
- Test: `skills/gpt-image-2-skill/scripts/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("config set-user-agent stores a custom global user agent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-skill-test-"));
  const codexHome = path.join(tempDir, ".codex");
  const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpt_image_2_skill.cjs");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      cliPath,
      "--json",
      "config",
      "set-user-agent",
      "--value",
      "MyApp/1.0",
    ],
    { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } },
  );
  assert.equal(result.status, 0, result.stderr);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test skills/gpt-image-2-skill/scripts/cli.test.ts --test-name-pattern "config set-user-agent stores a custom global user agent"
```

Expected: fail with an unknown command or missing field error.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface AppConfig {
  version: 1;
  default_provider?: string;
  user_agent?: string;
  providers: Record<string, ProviderConfig>;
}

export function resolveUserAgent(config?: AppConfig) {
  const value = config?.user_agent?.trim();
  return value || "OpenAI/Python 1.61.1";
}
```

Add `config set-user-agent` and `config clear-user-agent` handlers in `cli-core.ts`, and make `config inspect` expose `user_agent` when set.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
node --test skills/gpt-image-2-skill/scripts/cli.test.ts
```

Expected: the new config tests pass and existing tests stay green.

### Task 2: Inject the resolved UA into all skill HTTP requests

**Files:**
- Modify: `skills/gpt-image-2-skill/scripts/openai-client.ts`
- Modify: `skills/gpt-image-2-skill/scripts/codex-client.ts`
- Modify: `skills/gpt-image-2-skill/scripts/image-sources.ts`
- Modify: `skills/gpt-image-2-skill/scripts/config-store.ts`
- Modify: `skills/gpt-image-2-skill/scripts/types.ts`
- Test: `skills/gpt-image-2-skill/scripts/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("OpenAI-compatible requests send the configured user agent header", async () => {
  const seen: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init = {}) => {
    seen.push({
      userAgent: (init.headers as Record<string, string>)?.["User-Agent"],
      url: String(_input),
    });
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: tinyPngBase64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});
```

Add a matching Codex request test that inspects the `fetch` headers for the POST to the Codex endpoint, and a remote image-source fetch test that inspects the `fetch` headers used by `loadImageSourceBytes(...)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
node --test skills/gpt-image-2-skill/scripts/cli.test.ts --test-name-pattern "user agent"
```

Expected: fail because the header is not yet wired through.

- [ ] **Step 3: Write the minimal implementation**

```ts
function buildUserAgentHeaders(userAgent: string) {
  return { "User-Agent": userAgent };
}
```

Thread `resolveUserAgent(readConfig())` into:

- OpenAI image requests
- OpenAI-compatible image requests
- Codex request/create flows
- remote HTTP image-source fetches

Merge the UA header with existing authorization/content headers without changing current request behavior.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
node --test skills/gpt-image-2-skill/scripts/cli.test.ts
```

Expected: all request-header tests pass.

### Task 3: Sync docs and keep behavior explicit

**Files:**
- Modify: `skills/gpt-image-2-skill/SKILL.md`
- Modify: `skills/gpt-image-2-skill/references/providers.md`
- Modify: `skills/gpt-image-2-skill/scripts/cli.test.ts`

- [ ] **Step 1: Write the failing doc assertion**

```ts
test("config inspect includes stored user_agent", () => {
  const result = childProcess.spawnSync(process.execPath, [cliPath, "--json", "config", "inspect"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.config.user_agent, "MyApp/1.0");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test skills/gpt-image-2-skill/scripts/cli.test.ts --test-name-pattern "stored user_agent"
```

- [ ] **Step 3: Update docs and output shape**

Document the new config commands and the default `OpenAI/Python 1.61.1` value in `SKILL.md`, and mention that custom UA applies globally.

- [ ] **Step 4: Run the full test suite**

Run:

```bash
node --test skills/gpt-image-2-skill/scripts/cli.test.ts
```

Expected: full green.
