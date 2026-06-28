import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  authenticateWithDeviceCode,
  chatCompletionsCreate,
  codexCloudflareHeaders,
  createIrisClient,
  IrisAuthError,
} from "../src/index.js";

describe("Codex client", () => {
  test("extracts Codex headers from ChatGPT account JWT claims", () => {
    const token = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });

    expect(codexCloudflareHeaders(token)).toMatchObject({
      "User-Agent": "codex_cli_rs/0.0.0",
      originator: "codex_cli_rs",
      "ChatGPT-Account-ID": "acct_123",
    });
  });

  test("chat completions use Codex auth, Codex headers, and /responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-"));
    const authFile = join(dir, "auth.json");
    const access = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_live" },
    });
    await writeFile(authFile, JSON.stringify({
      providers: {
        "openai-codex": {
          tokens: { access_token: access, refresh_token: "rt_live" },
          last_refresh: "2026-06-26T09:00:42.515779Z",
          auth_mode: "chatgpt",
        },
      },
    }));

    const fetchImpl = vi.fn(async () => sseResponse([
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "from Codex." },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ]));

    const result = await chatCompletionsCreate({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      sessionId: "sess_1",
    }, {
      authFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
    });

    expect(result.choices[0]?.message.content).toBe("Hello from Codex.");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${access}`,
          "ChatGPT-Account-ID": "acct_live",
          originator: "codex_cli_rs",
          session_id: "sess_1",
          "x-client-request-id": "sess_1",
        }),
      }),
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.stream).toBe(true);
  });

  test("refreshes expiring Codex tokens and writes rotated refresh token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-refresh-"));
    const authFile = join(dir, "auth.json");
    const oldAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 1 });
    const newAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeFile(authFile, JSON.stringify({
      providers: {
        "openai-codex": {
          tokens: { access_token: oldAccess, refresh_token: "rt_old" },
          auth_mode: "chatgpt",
        },
      },
      credential_pool: {
        "openai-codex": [{
          source: "device_code",
          auth_type: "oauth",
          access_token: oldAccess,
          refresh_token: "rt_old",
        }],
      },
    }));

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://auth.openai.com/oauth/token") {
        return jsonResponse({ access_token: newAccess, refresh_token: "rt_new" });
      }
      return jsonResponse({ id: "resp_2", status: "completed", output_text: "refreshed" });
    });

    const client = createIrisClient({
      authFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
    });
    await client.chatCompletionsCreate({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
    });

    const stored = JSON.parse(await readFile(authFile, "utf8"));
    expect(stored.providers["openai-codex"].tokens.access_token).toBe(newAccess);
    expect(stored.providers["openai-codex"].tokens.refresh_token).toBe("rt_new");
    expect(stored.credential_pool["openai-codex"][0].refresh_token).toBe("rt_new");
  });

  test("streams chat completion chunks from Codex Responses SSE frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-stream-"));
    const authFile = join(dir, "auth.json");
    await writeFile(authFile, JSON.stringify({
      providers: {
        "openai-codex": {
          tokens: {
            access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "rt_live",
          },
        },
      },
    }));
    const fetchImpl = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
    ].join(""), {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const chunks = [];
    for await (const chunk of createIrisClient({
      authFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
    }).chatCompletionsStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")).toBe("Hello");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("throws a loud error when no model is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-model-"));
    const authFile = join(dir, "auth.json");
    await writeFile(authFile, JSON.stringify({
      providers: {
        "openai-codex": {
          tokens: {
            access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "rt_live",
          },
        },
      },
    }));

    await expect(createIrisClient({ authFile }).chatCompletionsCreate({
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toMatchObject({
      code: "codex_model_missing",
    } satisfies Partial<IrisAuthError>);
  });

  test("maps Codex 429 responses to a rate-limit error with retry-after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-429-"));
    const authFile = join(dir, "auth.json");
    await writeFile(authFile, JSON.stringify({
      providers: {
        "openai-codex": {
          tokens: {
            access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "rt_live",
          },
        },
      },
    }));

    const fetchImpl = vi.fn(async () => new Response("slow down", {
      status: 429,
      headers: { "retry-after": "30" },
    }));

    await expect(createIrisClient({
      authFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
    }).chatCompletionsCreate({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toMatchObject({
      code: "codex_rate_limited",
      status: 429,
      retryAfterSeconds: 30,
    } satisfies Partial<IrisAuthError>);
  });

  test("imports Codex CLI tokens when the local store has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-import-"));
    const codexHome = await mkdtemp(join(tmpdir(), "iris-cli-"));
    const authFile = join(dir, "store-auth.json");
    const access = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeFile(authFile, JSON.stringify({ version: 1, providers: {}, credential_pool: {} }));
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: access, refresh_token: "rt_codex_cli" },
    }));

    const fetchImpl = vi.fn(async () => jsonResponse({
      id: "resp_import",
      status: "completed",
      output_text: "Imported.",
    }));

    const result = await createIrisClient({
      authFile,
      codexHome,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
    }).chatCompletionsCreate({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.choices[0]?.message.content).toBe("Imported.");
    const stored = JSON.parse(await readFile(authFile, "utf8"));
    expect(stored.providers["openai-codex"].tokens.access_token).toBe(access);
    expect(stored.providers["openai-codex"].tokens.refresh_token).toBe("rt_codex_cli");
  });

  test("falls back to a credential pool entry when no provider tokens exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-pool-"));
    const emptyCodexHome = await mkdtemp(join(tmpdir(), "iris-empty-"));
    const authFile = join(dir, "auth.json");
    const access = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeFile(authFile, JSON.stringify({
      credential_pool: {
        "openai-codex": [{
          source: "pool",
          auth_type: "oauth",
          access_token: access,
          refresh_token: "rt_pool",
          base_url: "https://chatgpt.com/backend-api/codex",
        }],
      },
    }));

    const fetchImpl = vi.fn(async () => jsonResponse({
      id: "resp_pool",
      status: "completed",
      output_text: "From pool.",
    }));

    const result = await createIrisClient({
      authFile,
      codexHome: emptyCodexHome,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
    }).chatCompletionsCreate({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.choices[0]?.message.content).toBe("From pool.");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("authenticates with the OAuth device-code flow and saves tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-device-"));
    const authFile = join(dir, "auth.json");
    const access = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({ user_code: "WXYZ-1234", device_auth_id: "dev_auth_1", interval: 0, expires_in: 900 });
      }
      if (target.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({ authorization_code: "auth_code_1", code_verifier: "verifier_1" });
      }
      if (target === "https://auth.openai.com/oauth/token") {
        return jsonResponse({ access_token: access, refresh_token: "rt_device" });
      }
      throw new Error(`unexpected url ${target}`);
    });

    let shownUserCode = "";
    const credentials = await authenticateWithDeviceCode({
      authFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lockTimeoutSeconds: 1,
      onUserCode(info) {
        shownUserCode = info.userCode;
      },
    });

    expect(shownUserCode).toBe("WXYZ-1234");
    expect(credentials.apiKey).toBe(access);
    const stored = JSON.parse(await readFile(authFile, "utf8"));
    expect(stored.providers["openai-codex"].tokens.access_token).toBe(access);
    expect(stored.credential_pool["openai-codex"][0].refresh_token).toBe("rt_device");
  }, 10000);
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function sseResponse(events: Array<Record<string, unknown>>, init: ResponseInit = {}) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

function fakeJwt(claims: Record<string, unknown>): string {
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode(claims),
    "sig",
  ].join(".");
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
