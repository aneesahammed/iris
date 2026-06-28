# Iris

A dependency-free TypeScript client that calls OpenAI's **Codex (ChatGPT) backend** using your
**ChatGPT subscription** (OAuth device-code) instead of an `OPENAI_API_KEY`. It exposes a familiar
Chat Completions API and translates it to the Responses API under the hood.

## Quickstart

```bash
npm install
npm run build
npm run smoke      # verifies auth + a real call end-to-end (logs you in if needed)
```

## Usage

```ts
import { chatCompletionsCreate } from "./dist/index.js";

const res = await chatCompletionsCreate({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Say hello in one sentence." }],
});
console.log(res.choices[0]?.message.content);
```

Streaming, device-code login, env vars (`IRIS_AUTH_FILE`, `IRIS_BASE_URL`, `IRIS_MODEL`, …), the
`~/.iris/auth.json` store, and how credentials are resolved are all documented in
**[docs/iris-auth.md](docs/iris-auth.md)**.

## Requirements

- **Node 18+**
- A **ChatGPT subscription with Codex access** (Plus/Pro/Team/etc.) — this talks to the ChatGPT-Codex
  backend, so a plain platform `OPENAI_API_KEY` account won't work here.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the vitest suite |
| `npm run check` | Build + test |
| `npm run smoke` | Build, then make a real authenticated call to confirm it works |
