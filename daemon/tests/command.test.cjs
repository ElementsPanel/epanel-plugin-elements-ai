const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../../../..");
const daemonRequire = Module.createRequire(path.join(root, "daemon/package.json"));
const ts = daemonRequire("typescript");

function load(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (id) => (Object.hasOwn(overrides, id) ? overrides[id] : daemonRequire(id));
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText,
    filename
  );
  return mod.exports;
}

const source = "external/epanel-plugin-elements-ai/daemon/src/backend/index.ts";

test("daemon command request validates its own security boundary", () => {
  const { commandRequest } = load(source);
  assert.deepEqual(commandRequest({ command: " java -version " }), {
    command: "java -version",
    timeoutSeconds: 15,
    maxChars: 16000
  });
  for (const value of [
    null,
    { command: "" },
    { command: "echo one\necho two" },
    { command: "x".repeat(4097) },
    { command: "echo ok", timeoutSeconds: 0 },
    { command: "echo ok", timeoutSeconds: 31 },
    { command: "echo ok", maxChars: 99 },
    { command: "echo ok", maxChars: 32001 },
    { command: "echo ok", unexpected: true }
  ])
    assert.throws(() => commandRequest(value));
});

test("daemon command selects the native shell without using an instance terminal", () => {
  const { commandInvocation } = load(source);
  assert.deepEqual(commandInvocation("java -version", "linux"), {
    executable: "/bin/sh",
    args: ["-c", "java -version"]
  });
  assert.deepEqual(commandInvocation("java -version", "win32", "C:\\Windows\\cmd.exe"), {
    executable: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", "java -version"]
  });
});

test("daemon command captures stdout, stderr and the exit code", async () => {
  const { executeCommand } = load(source);
  const result = await executeCommand({
    command: "printf stdout; printf stderr >&2; exit 7",
    timeoutSeconds: 2,
    maxChars: 1000
  });
  assert.equal(result.platform, process.platform);
  assert.equal(result.exitCode, 7);
  assert.match(result.content, /stdout/);
  assert.match(result.content, /stderr/);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
});

test("daemon command bounds output and terminates on timeout", async () => {
  const { executeCommand } = load(source);
  const truncated = await executeCommand({
    command: "printf '0123456789%.0s' $(seq 1 40)",
    timeoutSeconds: 2,
    maxChars: 100
  });
  assert.equal(truncated.content.length, 100);
  assert.equal(truncated.truncated, true);

  const started = Date.now();
  const timedOut = await executeCommand({ command: "sleep 5", timeoutSeconds: 1, maxChars: 100 });
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.timedOut, true);
  assert.ok(Date.now() - started < 3000);
});

test("daemon plugin exposes only its dedicated command event", async () => {
  const { apply, COMMAND_EVENT } = load(source);
  let registered;
  let response;
  const ctx = {
    protocol: {
      on(event, handler) {
        registered = { event, handler };
      },
      response(_routerCtx, value) {
        response = value;
      },
      responseError(_routerCtx, error) {
        throw error;
      }
    }
  };
  apply(ctx);
  assert.equal(registered.event, COMMAND_EVENT);
  await registered.handler({}, { command: "printf direct", timeoutSeconds: 2, maxChars: 100 });
  assert.equal(response.content, "direct");
});
