// Smoke test: proves end-to-end auth + a real Codex call actually work.
//   npm run smoke            (set IRIS_MODEL to override the model)
// ponytail: also runs the device-code login if no creds exist yet, so it stays one command.
import { authenticateWithDeviceCode, chatCompletionsCreate, IrisAuthError } from "../dist/index.js";

const model = process.env.IRIS_MODEL ?? "gpt-5.5";

const ask = () =>
  chatCompletionsCreate({
    model,
    messages: [{ role: "user", content: "Reply with exactly: it works" }],
  }).then((r) => r.choices[0]?.message.content ?? "");

try {
  let out;
  try {
    out = await ask();
  } catch (error) {
    if (error instanceof IrisAuthError && error.reloginRequired) {
      console.log("No usable credentials found — starting device-code login...\n");
      await authenticateWithDeviceCode({
        onUserCode: (i) => console.log(`→ Open ${i.verificationUri} and enter code: ${i.userCode}\n`),
      });
      out = await ask();
    } else {
      throw error;
    }
  }
  console.log(`\n✅ Working. model=${model}\n   response: ${JSON.stringify(out)}`);
} catch (error) {
  console.error(`\n❌ Not working: [${error?.code ?? "error"}] ${error?.message ?? error}`);
  process.exitCode = 1;
}
