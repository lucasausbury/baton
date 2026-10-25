// Stands in for `claude -p` in the runner tests. It records how it was spawned
// so the test can assert on the argument list, then emits stream-json and exits
// according to AWM_TEST_MODE.
import { writeFileSync } from "node:fs";

const out = process.env.AWM_TEST_ARGV_OUT;
if (out) {
  writeFileSync(
    out,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }, null, 2),
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

if (mode === "hang") {
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
