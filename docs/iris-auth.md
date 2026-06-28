# Iris Auth Mechanism

Iris talks to OpenAI's Codex (ChatGPT) backend **without** an `OPENAI_API_KEY`.

It uses OpenAI OAuth device-code auth with client id `app_EMoamEEZ73f0CkXaXp7hrann`, stores tokens in `~/.iris/auth.json` by default, and calls:

```text
POST https://chatgpt.com/backend-api/codex/responses
```

## Required runtime headers

These headers are sent on every request to match the working Codex wire profile:

```text
Authorization: Bearer <access_token>
User-Agent: codex_cli_rs/0.0.0
originator: codex_cli_rs
ChatGPT-Account-ID: <chatgpt_account_id from JWT>
```

Iris is standalone and does not read `~/.hermes` unless you explicitly point `IRIS_AUTH_FILE` there.

## Token refresh

```text
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
refresh_token=<refresh_token>
client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

The access-token JWT `exp` is checked with a 120-second skew. Refresh writes the rotated token pair back to the auth store.

## Where credentials come from

`resolveRuntimeCredentials()` tries, in order:

1. The local auth store (`~/.iris/auth.json`), `providers["openai-codex"].tokens`.
2. **Import from the official Codex CLI** at `~/.codex/auth.json` (set `CODEX_HOME` to override), then save into the local store.
3. The interactive **device-code login** (`authenticateWithDeviceCode()`), which mints fresh tokens and writes the store.

So no external tool needs to be installed or running — only OpenAI's auth + Codex backend.

## Run

```bash
cd /Users/aneesahammed/Documents/dev/ai/iris
npm install
npm run build
```

## Quick test

One command to check that auth + a real Codex call actually work end-to-end:

```bash
npm run smoke          # or: yarn smoke
```

- Builds, then makes a real chat call and prints `✅ Working. model=... response: "it works"`.
- If you have no usable credentials yet, it starts the **device-code login** (prints a URL + code to approve in the browser), then retries automatically.
- Override the model with `IRIS_MODEL=gpt-5.5 npm run smoke`.
- The command is the script name — run `npm run smoke` / `yarn smoke`, not `yarn smoke.mjs`. Works from any directory in the repo.

Example:

```ts
import { chatCompletionsCreate, chatCompletionsStream } from "./dist/index.js";

const response = await chatCompletionsCreate({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Say hello in one sentence." }],
});

console.log(response.choices[0]?.message.content);

for await (const chunk of chatCompletionsStream({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Count to three." }],
})) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

Optional env:

```bash
export IRIS_AUTH_FILE="$HOME/.iris/auth.json"
export IRIS_BASE_URL="https://chatgpt.com/backend-api/codex"
export IRIS_MODEL="gpt-5.5"
export IRIS_CONFIG_FILE="./iris-client.config.json"
# CODEX_HOME points at the official Codex CLI home for token import (default: ~/.codex)
```

Config file shape:

```json
{
  "authFile": "~/.iris/auth.json",
  "baseUrl": "https://chatgpt.com/backend-api/codex",
  "model": "gpt-5.5",
  "refreshSkewSeconds": 120
}
```

To create fresh credentials from TypeScript:

```ts
import { authenticateWithDeviceCode } from "./dist/index.js";

await authenticateWithDeviceCode({
  onUserCode(info) {
    console.log(`Open ${info.verificationUri} and enter ${info.userCode}`);
  },
});
```
