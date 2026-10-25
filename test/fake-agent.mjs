// Stands in for `claude -p` in the runner tests. It records how it was spawned
// so the test can assert on the argument list, then emits stream-json and exits
// according to AWM_TEST_MODE.
import { writeFileSync } from "node:fs";

const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CONFIG_DIR",
];

const out = process.env.AWM_TEST_ARGV_OUT;
if (out) {
  const credentialEnv = {};
  for (const key of CREDENTIAL_VARS) {
    if (key in process.env) credentialEnv[key] = process.env[key];
  }
  writeFileSync(
    out,
    JSON.stringify(
      { argv: process.argv.slice(2), cwd: process.cwd(), credentialEnv },
      null,
      2,
    ),
    "utf8",
  );
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const mode = process.env.AWM_TEST_MODE ?? "ok";

emit({ type: "system", subtype: "init", model: "fake-model" });
emit({
  type: "assistant",
  message: { content: [{ type: "text", text: "Looking at the config." }] },
});
emit({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Bash", input: { command: "cargo nextest run" } }],
  },
});

if (mode === "authfail") {
  emit({ type: "system", subtype: "api_retry", attempt: 1, error: "authentication_failed" });
  emit({
    type: "result",
    subtype: "error_during_execution",
    result: "Login expired · Please run /login",
  });
  process.exit(1);
} else if (mode === "hang") {
  // Stay alive so the test can cancel it. Keep the event loop busy.
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  emit({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "3 tests failed" }] },
  });
  process.stderr.write("cargo exited 101\n");
  process.exit(2);
} else {
  emit({ type: "result", subtype: "success", result: "All 48 tests pass.", total_cost_usd: 0.1234 });
  process.exit(0);
}
