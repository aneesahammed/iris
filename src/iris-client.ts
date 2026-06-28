import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_AUTH_ISSUER = "https://auth.openai.com";
const DEFAULT_REFRESH_SKEW_SECONDS = 120;
const DEFAULT_REFRESH_TIMEOUT_SECONDS = 20;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 25;

type FetchLike = typeof fetch;

export interface IrisConfig {
  authFile: string;
  baseUrl: string;
  model?: string;
  configFile?: string;
  codexHome?: string;
  refreshSkewSeconds: number;
  refreshTimeoutSeconds: number;
  lockTimeoutSeconds: number;
  fetchImpl?: FetchLike;
}

export interface IrisOptions extends Partial<IrisConfig> {
  configFile?: string;
}

export interface RuntimeCredentials {
  provider: "openai-codex";
  baseUrl: string;
  apiKey: string;
  source: "iris-auth-store" | "credential-pool" | "codex-cli-import";
  lastRefresh?: string;
  authMode: "chatgpt";
}

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content?: string | Array<Record<string, unknown>> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    call_id?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  reasoning?: { effort?: string; summary?: string };
  sessionId?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null };
    finish_reason: string | null;
  }>;
  usage?: unknown;
  response: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
}

export interface DeviceCodeLoginInfo {
  verificationUri: string;
  userCode: string;
  expiresInSeconds?: number;
}

export interface DeviceCodeLoginOptions extends IrisOptions {
  save?: boolean;
  openBrowserMessage?: boolean;
  onUserCode?: (info: DeviceCodeLoginInfo) => void;
  pollTimeoutSeconds?: number;
}

export class IrisAuthError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly reloginRequired: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      code: string;
      status?: number;
      reloginRequired?: boolean;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "IrisAuthError";
    this.code = options.code;
    this.status = options.status;
    this.reloginRequired = options.reloginRequired ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

interface AuthStore {
  version?: number;
  providers?: Record<string, ProviderState | undefined>;
  credential_pool?: Record<string, PoolEntry[] | undefined>;
  active_provider?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface ProviderState {
  tokens?: CodexTokens;
  last_refresh?: string;
  auth_mode?: string;
  label?: string;
  [key: string]: unknown;
}

interface CodexTokens {
  access_token?: string;
  refresh_token?: string;
  [key: string]: unknown;
}

interface PoolEntry {
  provider?: string;
  id?: string;
  label?: string;
  auth_type?: string;
  source?: string;
  access_token?: string;
  refresh_token?: string;
  base_url?: string;
  last_refresh?: string;
  [key: string]: unknown;
}

interface LockHandle {
  release(): Promise<void>;
}

export function loadIrisConfig(options: IrisOptions = {}): IrisConfig {
  const env = process.env;
  const configFile = options.configFile ?? env.IRIS_CONFIG_FILE;
  const fileConfig = configFile ? readJsonConfig(configFile) : {};
  const authFile = expandHome(
    options.authFile ??
      stringValue(fileConfig.authFile) ??
      env.IRIS_AUTH_FILE ??
      join(homedir(), ".iris", "auth.json"),
  );
  const baseUrl = trimTrailingSlash(
    options.baseUrl ??
      stringValue(fileConfig.baseUrl) ??
      env.IRIS_BASE_URL ??
      DEFAULT_CODEX_BASE_URL,
  );

  return {
    authFile,
    baseUrl,
    model: options.model ?? stringValue(fileConfig.model) ?? env.IRIS_MODEL,
    configFile,
    codexHome: expandHome(options.codexHome ?? stringValue(fileConfig.codexHome) ?? env.CODEX_HOME ?? join(homedir(), ".codex")),
    refreshSkewSeconds: numberValue(
      options.refreshSkewSeconds ?? fileConfig.refreshSkewSeconds ?? env.IRIS_REFRESH_SKEW_SECONDS,
      DEFAULT_REFRESH_SKEW_SECONDS,
    ),
    refreshTimeoutSeconds: numberValue(
      options.refreshTimeoutSeconds ?? fileConfig.refreshTimeoutSeconds ?? env.IRIS_REFRESH_TIMEOUT_SECONDS,
      DEFAULT_REFRESH_TIMEOUT_SECONDS,
    ),
    lockTimeoutSeconds: numberValue(
      options.lockTimeoutSeconds ?? fileConfig.lockTimeoutSeconds ?? env.IRIS_LOCK_TIMEOUT_SECONDS,
      DEFAULT_LOCK_TIMEOUT_SECONDS,
    ),
    fetchImpl: options.fetchImpl,
  };
}

export function createIrisClient(options: IrisOptions = {}) {
  const config = loadIrisConfig(options);
  return new IrisClient(config);
}

export class IrisClient {
  constructor(readonly config: IrisConfig) {}

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const credentials = await this.resolveRuntimeCredentials(options);
    return credentials.apiKey;
  }

  async resolveRuntimeCredentials(options: { forceRefresh?: boolean } = {}): Promise<RuntimeCredentials> {
    const authStore = await loadAuthStore(this.config.authFile);
    const provider = authStore.providers?.["openai-codex"];
    const providerTokens = provider?.tokens;

    if (hasUsableTokenPair(providerTokens)) {
      const tokens = await this.refreshIfNeeded(providerTokens, options.forceRefresh ?? false);
      return {
        provider: "openai-codex",
        baseUrl: this.config.baseUrl,
        apiKey: requiredToken(tokens.access_token, "access_token"),
        source: "iris-auth-store",
        lastRefresh: provider?.last_refresh,
        authMode: "chatgpt",
      };
    }

    const imported = await this.tryImportCodexCliTokens();
    if (imported) {
      await this.saveCodexTokens(imported);
      return {
        provider: "openai-codex",
        baseUrl: this.config.baseUrl,
        apiKey: requiredToken(imported.access_token, "access_token"),
        source: "codex-cli-import",
        lastRefresh: new Date().toISOString(),
        authMode: "chatgpt",
      };
    }

    const poolEntry = selectPoolEntry(authStore);
    if (poolEntry?.access_token) {
      const refreshed = await this.refreshPoolEntryIfNeeded(poolEntry, options.forceRefresh ?? false);
      return {
        provider: "openai-codex",
        baseUrl: trimTrailingSlash(refreshed.base_url || this.config.baseUrl),
        apiKey: requiredToken(refreshed.access_token, "access_token"),
        source: "credential-pool",
        lastRefresh: refreshed.last_refresh,
        authMode: "chatgpt",
      };
    }

    throw new IrisAuthError(
      `No Codex credentials found. Expected ${this.config.authFile} with providers.openai-codex.tokens. Run authenticateWithDeviceCode() to log in.`,
      { code: "codex_auth_missing", reloginRequired: true },
    );
  }

  async authenticateWithDeviceCode(options: DeviceCodeLoginOptions = {}): Promise<RuntimeCredentials> {
    const cfg = loadIrisConfig({ ...this.config, ...options });
    const fetchImpl = getFetch(cfg);
    const deviceResp = await fetchImpl(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    });
    if (deviceResp.status === 429) {
      throw rateLimitError("OpenAI is rate-limiting Codex login requests.", deviceResp);
    }
    if (!deviceResp.ok) {
      throw new IrisAuthError(`Device code request returned status ${deviceResp.status}.`, {
        code: "device_code_request_error",
        status: deviceResp.status,
      });
    }

    const deviceData = asRecord(await readJson(deviceResp, "device_code_invalid_json"));
    const userCode = stringValue(deviceData.user_code);
    const deviceAuthId = stringValue(deviceData.device_auth_id);
    const interval = Math.max(3, numberValue(deviceData.interval, 5));
    if (!userCode || !deviceAuthId) {
      throw new IrisAuthError("Device code response missing user_code or device_auth_id.", {
        code: "device_code_incomplete",
        reloginRequired: true,
      });
    }

    const info = {
      verificationUri: `${CODEX_AUTH_ISSUER}/codex/device`,
      userCode,
      expiresInSeconds: numberValue(deviceData.expires_in, 0) || undefined,
    };
    if (options.onUserCode) {
      options.onUserCode(info);
    } else {
      console.error(`Open ${info.verificationUri} and enter code ${info.userCode}`);
    }

    const codeResp = await pollDeviceAuth(fetchImpl, deviceAuthId, userCode, interval, options.pollTimeoutSeconds ?? 15 * 60);
    const authorizationCode = stringValue(codeResp.authorization_code);
    const codeVerifier = stringValue(codeResp.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new IrisAuthError("Device auth response missing authorization_code or code_verifier.", {
        code: "device_code_incomplete_exchange",
        reloginRequired: true,
      });
    }

    const tokenResp = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: `${CODEX_AUTH_ISSUER}/deviceauth/callback`,
        client_id: CODEX_OAUTH_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
    });
    if (tokenResp.status === 429) {
      throw rateLimitError("OpenAI is rate-limiting Codex token exchange.", tokenResp);
    }
    if (!tokenResp.ok) {
      throw new IrisAuthError(`Token exchange returned status ${tokenResp.status}.`, {
        code: "token_exchange_error",
        status: tokenResp.status,
        reloginRequired: true,
      });
    }

    const tokens = await readJson(tokenResp, "token_exchange_invalid_json") as CodexTokens;
    if (!tokens.access_token) {
      throw new IrisAuthError("Token exchange did not return an access_token.", {
        code: "token_exchange_no_access_token",
        reloginRequired: true,
      });
    }
    if (options.save !== false) {
      await this.saveCodexTokens(tokens);
    }

    return {
      provider: "openai-codex",
      baseUrl: cfg.baseUrl,
      apiKey: tokens.access_token,
      source: "iris-auth-store",
      lastRefresh: new Date().toISOString(),
      authMode: "chatgpt",
    };
  }

  async responsesCreate(payload: Record<string, unknown>, options: { sessionId?: string } = {}): Promise<unknown> {
    const credentials = await this.resolveRuntimeCredentials();
    const body = { ...payload, stream: true };
    const response = await this.postResponses(credentials, body, options);
    if (!response.ok) {
      throw await responseError(response, "codex_response_error");
    }
    return readResponsesPayload(response, stringValue(payload.model) ?? "");
  }

  async *responsesStream(payload: Record<string, unknown>, options: { sessionId?: string } = {}): AsyncIterable<Record<string, unknown>> {
    const credentials = await this.resolveRuntimeCredentials();
    const response = await this.postResponses(credentials, { ...payload, stream: true }, options);
    if (!response.ok) {
      throw await responseError(response, "codex_stream_error");
    }
    yield* parseSse(response);
  }

  async chatCompletionsCreate(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = this.resolveModel(request.model);
    const payload = chatRequestToResponsesPayload(request, model);
    const response = await this.responsesCreate(payload, { sessionId: request.sessionId });
    return responseToChatCompletion(response, model);
  }

  async *chatCompletionsStream(request: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const model = this.resolveModel(request.model);
    const payload = chatRequestToResponsesPayload(request, model);
    let sawRole = false;
    for await (const event of this.responsesStream(payload, { sessionId: request.sessionId })) {
      const type = stringValue(event.type) ?? "";
      if (type === "response.output_text.delta") {
        const delta = rawStringValue(event.delta) ?? "";
        yield chatChunk(model, sawRole ? { content: delta } : { role: "assistant", content: delta }, null);
        sawRole = true;
      } else if (type === "response.completed") {
        yield chatChunk(model, sawRole ? {} : { role: "assistant" }, "stop");
      } else if (type === "response.incomplete") {
        yield chatChunk(model, sawRole ? {} : { role: "assistant" }, "length");
      } else if (type === "response.failed" || type === "error") {
        throw new IrisAuthError(`Codex stream failed: ${JSON.stringify(event)}`, {
          code: "codex_stream_failed",
          reloginRequired: false,
        });
      }
    }
  }

  private async postResponses(
    credentials: RuntimeCredentials,
    payload: Record<string, unknown>,
    options: { sessionId?: string },
  ): Promise<Response> {
    const headers = {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
      ...codexCloudflareHeaders(credentials.apiKey),
      ...sessionHeaders(options.sessionId),
    };
    return getFetch(this.config)(`${credentials.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }

  private resolveModel(requestModel?: string): string {
    const model = requestModel || this.config.model;
    if (!model) {
      throw new IrisAuthError(
        "No model configured. Pass request.model or set IRIS_MODEL. This client intentionally does not hardcode a Codex model because the allow-list changes.",
        { code: "codex_model_missing" },
      );
    }
    return model;
  }

  private async refreshIfNeeded(tokens: CodexTokens, forceRefresh: boolean): Promise<CodexTokens> {
    const accessToken = requiredToken(tokens.access_token, "access_token");
    if (!forceRefresh && !isJwtExpiring(accessToken, this.config.refreshSkewSeconds)) {
      return tokens;
    }

    return withAuthLock(this.config, async () => {
      const authStore = await loadAuthStore(this.config.authFile);
      const currentTokens = authStore.providers?.["openai-codex"]?.tokens;
      if (!hasUsableTokenPair(currentTokens)) {
        throw new IrisAuthError("Codex auth store lost its token pair during refresh.", {
          code: "codex_auth_missing",
          reloginRequired: true,
        });
      }
      const currentAccess = requiredToken(currentTokens.access_token, "access_token");
      if (!forceRefresh && !isJwtExpiring(currentAccess, this.config.refreshSkewSeconds)) {
        return currentTokens;
      }

      const refreshed = await this.refreshTokens(currentTokens);
      await saveCodexTokensToStore(this.config, refreshed, currentTokens);
      return refreshed;
    });
  }

  private async refreshPoolEntryIfNeeded(entry: PoolEntry, forceRefresh: boolean): Promise<PoolEntry> {
    if (!entry.access_token) {
      return entry;
    }
    if (!entry.refresh_token || (!forceRefresh && !isJwtExpiring(entry.access_token, this.config.refreshSkewSeconds))) {
      return entry;
    }
    return withAuthLock(this.config, async () => {
      const authStore = await loadAuthStore(this.config.authFile);
      const selected = selectPoolEntry(authStore) ?? entry;
      if (!selected.access_token || !selected.refresh_token) {
        return selected;
      }
      if (!forceRefresh && !isJwtExpiring(selected.access_token, this.config.refreshSkewSeconds)) {
        return selected;
      }
      const refreshed = await this.refreshTokens(selected);
      selected.access_token = refreshed.access_token;
      selected.refresh_token = refreshed.refresh_token;
      selected.last_refresh = refreshed.last_refresh;
      selected.base_url = selected.base_url || this.config.baseUrl;
      await saveAuthStore(this.config.authFile, authStore);
      return selected;
    });
  }

  private async refreshTokens(tokens: CodexTokens): Promise<CodexTokens & { last_refresh: string }> {
    try {
      return await refreshCodexTokens(this.config, tokens);
    } catch (error) {
      if (error instanceof IrisAuthError && error.reloginRequired) {
        const imported = await this.tryImportCodexCliTokens();
        if (imported) {
          await this.saveCodexTokens(imported);
          return { ...imported, last_refresh: new Date().toISOString() };
        }
      }
      throw error;
    }
  }

  private async tryImportCodexCliTokens(): Promise<CodexTokens | undefined> {
    const authPath = join(this.config.codexHome ?? join(homedir(), ".codex"), "auth.json");
    try {
      const payload = JSON.parse(await readFile(authPath, "utf8")) as { tokens?: CodexTokens };
      const tokens = payload.tokens;
      if (!hasUsableTokenPair(tokens)) {
        return undefined;
      }
      if (isJwtExpiring(requiredToken(tokens.access_token, "access_token"), 0)) {
        return undefined;
      }
      return { ...tokens };
    } catch {
      return undefined;
    }
  }

  private async saveCodexTokens(tokens: CodexTokens): Promise<void> {
    await withAuthLock(this.config, async () => {
      const authStore = await loadAuthStore(this.config.authFile);
      await saveCodexTokensToStore(this.config, tokens, authStore.providers?.["openai-codex"]?.tokens);
    });
  }
}

export async function authenticateWithDeviceCode(options: DeviceCodeLoginOptions = {}): Promise<RuntimeCredentials> {
  return createIrisClient(options).authenticateWithDeviceCode(options);
}

export async function chatCompletionsCreate(
  request: ChatCompletionRequest,
  options: IrisOptions = {},
): Promise<ChatCompletionResponse> {
  return createIrisClient(options).chatCompletionsCreate(request);
}

export function chatCompletionsStream(
  request: ChatCompletionRequest,
  options: IrisOptions = {},
): AsyncIterable<ChatCompletionChunk> {
  return createIrisClient(options).chatCompletionsStream(request);
}

export function codexCloudflareHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0",
    originator: "codex_cli_rs",
  };
  const claims = decodeJwtClaims(accessToken);
  const authClaims = claims["https://api.openai.com/auth"];
  if (authClaims && typeof authClaims === "object" && !Array.isArray(authClaims)) {
    const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId === "string" && accountId) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
  }
  return headers;
}

function chatRequestToResponsesPayload(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  const instructions = request.messages
    .filter((msg) => msg.role === "system" || msg.role === "developer")
    .map((msg) => contentToText(msg.content))
    .filter(Boolean)
    .join("\n\n");
  const payload: Record<string, unknown> = {
    model,
    instructions: instructions || "You are a helpful assistant.",
    input: chatMessagesToResponsesInput(request.messages),
    store: false,
  };
  if (request.tools?.length) {
    payload.tools = request.tools.map(chatToolToResponseTool).filter(Boolean);
    payload.tool_choice = request.tool_choice ?? "auto";
    payload.parallel_tool_calls = true;
  }
  if (request.reasoning) {
    payload.reasoning = request.reasoning;
    payload.include = ["reasoning.encrypted_content"];
  } else {
    payload.reasoning = { effort: "medium", summary: "auto" };
    payload.include = ["reasoning.encrypted_content"];
  }
  if (request.sessionId) {
    payload.prompt_cache_key = request.sessionId;
  }
  return payload;
}

function chatMessagesToResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      continue;
    }
    if (msg.role === "tool") {
      const callId = msg.tool_call_id;
      if (callId) {
        items.push({ type: "function_call_output", call_id: callId, output: contentToText(msg.content) });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const text = contentToText(msg.content);
      if (text) {
        items.push({ role: "assistant", content: text });
      }
      for (const toolCall of msg.tool_calls ?? []) {
        const fn = toolCall.function;
        const name = fn?.name;
        if (!name) {
          continue;
        }
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        items.push({
          type: "function_call",
          call_id: toolCall.call_id || toolCall.id || deterministicCallId(name, args, items.length),
          name,
          arguments: args || "{}",
        });
      }
      continue;
    }
    items.push({ role: "user", content: contentToText(msg.content) });
  }
  return items;
}

function responseToChatCompletion(response: unknown, model: string): ChatCompletionResponse {
  const content = extractOutputText(response);
  const status = objectString(response, "status");
  return {
    id: objectString(response, "id") ?? `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: status === "completed" ? "stop" : status ?? null,
      },
    ],
    usage: objectValue(response, "usage"),
    response,
  };
}

function extractOutputText(response: unknown): string {
  const direct = objectString(response, "output_text");
  if (direct) {
    return direct;
  }
  const output = objectValue(response, "output");
  if (!Array.isArray(output)) {
    return "";
  }
  const chunks: string[] = [];
  for (const item of output) {
    const content = objectValue(item, "content");
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const text = objectString(part, "text");
      if (text) {
        chunks.push(text);
      }
    }
  }
  return chunks.join("");
}

async function readResponsesPayload(response: Response, model: string): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return readJson(response, "codex_response_invalid_json");
  }
  return consumeResponsesEventStream(parseSse(response), model);
}

async function consumeResponsesEventStream(events: AsyncIterable<Record<string, unknown>>, model: string): Promise<Record<string, unknown>> {
  const outputItems: unknown[] = [];
  const textParts: string[] = [];
  let responseId: string | undefined;
  let status = "completed";
  let usage: unknown;
  let incompleteDetails: unknown;
  let errorPayload: unknown;
  let sawTerminal = false;

  for await (const event of events) {
    const type = stringValue(event.type) ?? "";
    if (type === "error") {
      throw new IrisAuthError(`Codex stream emitted an error event: ${JSON.stringify(event)}`, {
        code: "codex_stream_error_event",
      });
    }
    if (type === "response.output_text.delta") {
      const delta = rawStringValue(event.delta);
      if (delta !== undefined) {
        textParts.push(delta);
      }
      continue;
    }
    if (type === "response.output_item.done") {
      const item = objectValue(event, "item");
      if (item) {
        outputItems.push(item);
      }
      continue;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      sawTerminal = true;
      const resp = objectValue(event, "response");
      responseId = objectString(resp, "id") ?? responseId;
      status = objectString(resp, "status") ?? (type === "response.completed" ? "completed" : type.replace("response.", ""));
      usage = objectValue(resp, "usage") ?? usage;
      incompleteDetails = objectValue(resp, "incomplete_details") ?? incompleteDetails;
      errorPayload = objectValue(resp, "error") ?? errorPayload;
      break;
    }
  }

  const outputText = textParts.join("");
  const output = outputItems.length > 0
    ? outputItems
    : outputText
      ? [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: outputText }] }]
      : [];

  if (!sawTerminal && output.length === 0) {
    throw new IrisAuthError("Codex stream ended without a terminal response or output.", {
      code: "codex_stream_missing_terminal",
    });
  }
  if (status === "failed") {
    throw new IrisAuthError(`Codex stream failed: ${JSON.stringify(errorPayload ?? {})}`, {
      code: "codex_stream_failed",
    });
  }

  return {
    id: responseId ?? `resp_${Date.now()}`,
    status,
    model,
    output_text: outputText,
    output,
    usage,
    incomplete_details: incompleteDetails,
    error: errorPayload,
  };
}

async function refreshCodexTokens(config: IrisConfig, tokens: CodexTokens): Promise<CodexTokens & { last_refresh: string }> {
  const refreshToken = requiredToken(tokens.refresh_token, "refresh_token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5, config.refreshTimeoutSeconds) * 1000);
  let response: Response;
  try {
    response = await getFetch(config)(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new IrisAuthError(`Codex token refresh failed before receiving a response: ${errorMessage(error)}`, {
      code: "codex_refresh_network_error",
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    throw rateLimitError("Codex provider quota exhausted. Credentials are still valid.", response);
  }
  if (!response.ok) {
    let code = "codex_refresh_failed";
    let message = `Codex token refresh failed with status ${response.status}.`;
    try {
      const err = await response.clone().json() as Record<string, unknown>;
      const nested = err.error;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        code = stringValue((nested as Record<string, unknown>).code) ?? stringValue((nested as Record<string, unknown>).type) ?? code;
        message = stringValue((nested as Record<string, unknown>).message) ?? message;
      } else if (typeof nested === "string") {
        code = nested;
        message = stringValue(err.error_description) ?? stringValue(err.message) ?? message;
      }
    } catch {
      // Keep the status-only error.
    }
    throw new IrisAuthError(message, {
      code,
      status: response.status,
      reloginRequired: response.status === 401 || response.status === 403 || ["invalid_grant", "invalid_token", "invalid_request", "refresh_token_reused"].includes(code),
    });
  }

  const payload = await readJson(response, "codex_refresh_invalid_json") as CodexTokens;
  if (!payload.access_token) {
    throw new IrisAuthError("Codex token refresh response was missing access_token.", {
      code: "codex_refresh_missing_access_token",
      reloginRequired: true,
    });
  }
  return {
    ...tokens,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || refreshToken,
    last_refresh: new Date().toISOString(),
  };
}

async function saveCodexTokensToStore(config: IrisConfig, tokens: CodexTokens, previousTokens?: CodexTokens): Promise<void> {
  const authStore = await loadAuthStore(config.authFile);
  const lastRefresh = new Date().toISOString();
  authStore.version = authStore.version ?? 1;
  authStore.providers = authStore.providers ?? {};
  authStore.providers["openai-codex"] = {
    ...(authStore.providers["openai-codex"] ?? {}),
    tokens,
    last_refresh: lastRefresh,
    auth_mode: "chatgpt",
  };
  authStore.credential_pool = authStore.credential_pool ?? {};
  const pool = authStore.credential_pool["openai-codex"] ?? [];
  if (pool.length === 0) {
    pool.push({
      id: "tscodx",
      label: "typescript-device-code",
      auth_type: "oauth",
      priority: 0,
      source: "manual:device_code",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      base_url: config.baseUrl,
      last_refresh: lastRefresh,
      request_count: 0,
    });
  } else {
    for (const entry of pool) {
      const source = String(entry.source ?? "");
      const matchesPrevious =
        entry.access_token === previousTokens?.access_token ||
        entry.refresh_token === previousTokens?.refresh_token ||
        source === "device_code";
      if (source.includes("device_code") && matchesPrevious) {
        entry.access_token = tokens.access_token;
        entry.refresh_token = tokens.refresh_token;
        entry.base_url = entry.base_url || config.baseUrl;
        entry.last_refresh = lastRefresh;
        entry.last_status = null;
        entry.last_error_code = null;
        entry.last_error_reason = null;
        entry.last_error_message = null;
      }
    }
  }
  authStore.credential_pool["openai-codex"] = pool;
  authStore.active_provider = authStore.active_provider ?? "openai-codex";
  authStore.updated_at = lastRefresh;
  await saveAuthStore(config.authFile, authStore);
}

async function loadAuthStore(authFile: string): Promise<AuthStore> {
  try {
    return JSON.parse(await readFile(authFile, "utf8")) as AuthStore;
  } catch (error) {
    if (isNotFound(error)) {
      return { version: 1, providers: {}, credential_pool: {} };
    }
    throw new IrisAuthError(`Could not read Codex auth file ${authFile}: ${errorMessage(error)}`, {
      code: "auth_store_read_failed",
      cause: error,
    });
  }
}

async function saveAuthStore(authFile: string, authStore: AuthStore): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true });
  const tmp = `${authFile}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(authStore, null, 2)}\n`;
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, authFile);
}

async function withAuthLock<T>(config: IrisConfig, fn: () => Promise<T>): Promise<T> {
  const lockPath = config.authFile.replace(/\.json$/u, ".lock");
  const lock = await acquireFileLock(lockPath, config.lockTimeoutSeconds);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function acquireFileLock(lockPath: string, timeoutSeconds: number): Promise<LockHandle> {
  const perlLock = await tryAcquirePerlFlock(lockPath, timeoutSeconds);
  if (perlLock) {
    return perlLock;
  }
  return acquireFallbackLock(`${lockPath}.ts-lock`, timeoutSeconds);
}

async function tryAcquirePerlFlock(lockPath: string, timeoutSeconds: number): Promise<LockHandle | undefined> {
  await mkdir(dirname(lockPath), { recursive: true });
  const script = [
    "use Fcntl qw(:flock);",
    "my $path = shift;",
    "my $timeout = shift;",
    "open(my $fh, '>>', $path) or die \"open:$!\\n\";",
    "my $deadline = time() + $timeout;",
    "while (!flock($fh, LOCK_EX | LOCK_NB)) {",
    "  die \"timeout\\n\" if time() >= $deadline;",
    "  select(undef, undef, undef, 0.05);",
    "}",
    "print \"LOCKED\\n\";",
    "STDOUT->flush();",
    "<STDIN>;",
    "flock($fh, LOCK_UN);",
  ].join(" ");
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("perl", ["-e", script, lockPath, String(Math.max(1, timeoutSeconds))], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }

  const locked = await waitForLockLine(child, timeoutSeconds).catch(() => false);
  if (!locked) {
    child.kill();
    return undefined;
  }
  return {
    async release() {
      child.stdin.end("\n");
      await waitForExit(child, 2000).catch(() => child.kill());
    },
  };
}

function waitForLockLine(child: ChildProcessWithoutNullStreams, timeoutSeconds: number): Promise<boolean> {
  return new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => rejectLine(new Error("Timed out waiting for auth store lock")), Math.max(1, timeoutSeconds) * 1000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("LOCKED")) {
        clearTimeout(timer);
        resolveLine(true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectLine(error);
    });
    child.on("exit", (code) => {
      if (!stdout.includes("LOCKED")) {
        clearTimeout(timer);
        rejectLine(new Error(stderr || `Lock helper exited with ${code}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Timed out releasing auth store lock")), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function acquireFallbackLock(lockPath: string, timeoutSeconds: number): Promise<LockHandle> {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    try {
      const fd = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await fd.writeFile(`${process.pid}\n`);
      await fd.close();
      return {
        async release() {
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true });
      }
      await sleep(50);
    }
  }
  throw new IrisAuthError("Timed out waiting for auth store lock.", { code: "auth_lock_timeout" });
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > 60_000;
  } catch {
    return false;
  }
}

async function pollDeviceAuth(
  fetchImpl: FetchLike,
  deviceAuthId: string,
  userCode: string,
  intervalSeconds: number,
  timeoutSeconds: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const response = await fetchImpl(`${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (response.status === 200) {
      return readJson(response, "device_code_poll_invalid_json") as Promise<Record<string, unknown>>;
    }
    if (response.status === 403 || response.status === 404) {
      continue;
    }
    throw new IrisAuthError(`Device auth polling returned status ${response.status}.`, {
      code: "device_code_poll_error",
      status: response.status,
    });
  }
  throw new IrisAuthError("Login timed out waiting for browser approval.", {
    code: "device_code_timeout",
    reloginRequired: true,
  });
}

async function* parseSse(response: Response): AsyncIterable<Record<string, unknown>> {
  if (!response.body) {
    throw new IrisAuthError("Streaming response had no body.", { code: "codex_stream_missing_body" });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let splitAt: number;
    while ((splitAt = buffer.search(/\r?\n\r?\n/u)) >= 0) {
      const delimiter = /\r?\n\r?\n/u.exec(buffer);
      if (!delimiter) {
        break;
      }
      const frame = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + delimiter[0].length);
      const parsed = parseSseFrame(frame);
      if (parsed) {
        yield parsed;
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseSseFrame(tail);
    if (parsed) {
      yield parsed;
    }
  }
}

function parseSseFrame(frame: string): Record<string, unknown> | undefined {
  const dataLines = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return undefined;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return undefined;
  }
  return JSON.parse(data) as Record<string, unknown>;
}

function chatChunk(model: string, delta: { role?: "assistant"; content?: string }, finishReason: string | null): ChatCompletionChunk {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sessionHeaders(sessionId?: string): Record<string, string> {
  if (!sessionId) {
    return {};
  }
  return {
    session_id: sessionId,
    "x-client-request-id": sessionId,
  };
}

function chatToolToResponseTool(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  const fn = objectValue(tool, "function");
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
    return undefined;
  }
  const fnObj = fn as Record<string, unknown>;
  const name = stringValue(fnObj.name);
  if (!name) {
    return undefined;
  }
  return {
    type: "function",
    name,
    description: stringValue(fnObj.description) ?? "",
    strict: false,
    parameters: objectValue(fnObj, "parameters") ?? { type: "object", properties: {} },
  };
}

function deterministicCallId(name: string, args: string, index: number): string {
  const input = `${name}:${args}:${index}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return `call_${hash.toString(16).padStart(8, "0")}`;
}

function selectPoolEntry(authStore: AuthStore): PoolEntry | undefined {
  return authStore.credential_pool?.["openai-codex"]?.find((entry) => Boolean(entry.access_token));
}

function hasUsableTokenPair(tokens: CodexTokens | undefined): tokens is Required<Pick<CodexTokens, "access_token" | "refresh_token">> & CodexTokens {
  return Boolean(tokens?.access_token && tokens.refresh_token);
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new IrisAuthError(`Codex auth is missing ${field}. Re-authenticate with authenticateWithDeviceCode().`, {
      code: `codex_auth_missing_${field}`,
      reloginRequired: true,
    });
  }
  return value.trim();
}

function isJwtExpiring(token: string, skewSeconds: number): boolean {
  const exp = decodeJwtClaims(token).exp;
  if (typeof exp !== "number") {
    return false;
  }
  return exp <= Math.floor(Date.now() / 1000) + Math.max(0, skewSeconds);
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  if (token.split(".").length !== 3) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(base64UrlPad(token.split(".")[1] ?? ""), "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function base64UrlPad(input: string): string {
  return `${input}${"=".repeat((4 - (input.length % 4)) % 4)}`;
}

function contentToText(content: ChatMessage["content"]): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.image_url === "string") {
        return `[image: ${part.image_url}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function readJson(response: Response, code: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new IrisAuthError("Response returned invalid JSON.", { code, cause: error });
  }
}

async function responseError(response: Response, code: string): Promise<IrisAuthError> {
  if (response.status === 429) {
    return rateLimitError("Codex request was rate-limited. Credentials are still valid.", response);
  }
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = "";
  }
  return new IrisAuthError(`Codex request failed with status ${response.status}${detail ? `: ${truncate(detail, 600)}` : ""}`, {
    code,
    status: response.status,
    reloginRequired: response.status === 401 || response.status === 403,
  });
}

function rateLimitError(message: string, response: Response): IrisAuthError {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  return new IrisAuthError(retryAfterSeconds ? `${message} Retry after ${retryAfterSeconds}s.` : message, {
    code: "codex_rate_limited",
    status: 429,
    reloginRequired: false,
    retryAfterSeconds,
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  const nested = objectValue(value, key);
  return typeof nested === "string" ? nested : undefined;
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readJsonConfig(path: string): Record<string, unknown> {
  try {
    return JSON.parse(requireFsRead(path)) as Record<string, unknown>;
  } catch (error) {
    throw new IrisAuthError(`Could not read config file ${path}: ${errorMessage(error)}`, {
      code: "config_read_failed",
      cause: error,
    });
  }
}

function requireFsRead(path: string): string {
  return readFileSync(expandHome(path), "utf8");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

function getFetch(config: IrisConfig): FetchLike {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new IrisAuthError("No fetch implementation available. Use Node 18+ or pass fetchImpl.", {
      code: "fetch_missing",
    });
  }
  return fetchImpl.bind(globalThis);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
