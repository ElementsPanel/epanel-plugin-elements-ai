const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { PassThrough, Readable } = require("node:stream");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../../../..");
const panelRequire = Module.createRequire(path.join(root, "panel/package.json"));
const ts = panelRequire("typescript");
const source = "external/epanel-plugin-elements-ai/panel/src/";
function loader(overrides = {}) {
  const cache = new Map();
  function load(relative) {
    const filename = path.join(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename, module);
    cache.set(filename, mod);
    mod.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith(".")) {
        const base = path.resolve(path.dirname(filename), id);
        for (const candidate of [base + ".ts", path.join(base, "index.ts")])
          if (fs.existsSync(candidate)) return load(path.relative(root, candidate));
      }
      return panelRequire(id);
    };
    mod._compile(
      ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true
        }
      }).outputText,
      filename
    );
    return mod.exports;
  }
  return load;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = (delta, finish_reason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const model = {
  id: "one",
  name: "One",
  endpoint: "https://api.example/v1/chat/completions",
  model: "model",
  apiKey: "SECRET",
  selectionId: "preset:one",
  publicOnly: false
};

async function settingsFixture(legacy) {
  const load = loader();
  const { registerSettings } = load(source + "backend/settings.ts");
  const data = new Map(legacy ? [["EpanelPluginElementsAiSettings:config", legacy]] : []);
  let form;
  const ctx = {
    i18n: { $t: (key) => key },
    settingsForm: {
      declare: (value) => {
        form = value;
      }
    },
    storage: {
      getStorage: () => ({
        load: async (category, _type, id) => structuredClone(data.get(`${category}:${id}`) || null),
        store: async (category, id, value) => {
          data.set(`${category}:${id}`, structuredClone(value));
        }
      })
    }
  };
  const models = await registerSettings(ctx);
  return { models, form, data, load, ctx };
}

test("configuration contains only a preset list and migrates the legacy model without exposing keys", async () => {
  const f = await settingsFixture({
    endpoint: model.endpoint,
    model: model.model,
    apiKey: "SAVED_SECRET",
    allowUsers: false
  });
  assert.deepEqual(
    f.form.fields().map((field) => field.key),
    ["presets"]
  );
  assert.doesNotMatch(JSON.stringify(f.form.read()), /SAVED_SECRET/);
  assert.equal((await f.models.resolve("alice", "preset:default", false)).apiKey, "SAVED_SECRET");
  assert.equal(f.form.fields()[0].type, "list");
  const { validatePluginSettings } = f.load("common/src/plugin_contract.ts");
  const entries = f.form.read().presets;
  entries[0].name = "Renamed";
  entries.push({
    name: "Second",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "local",
    apiKey: "LOCAL_SECRET"
  });
  validatePluginSettings(f.form.fields(), { presets: entries });
  await f.form.write({ presets: entries });
  const list = await f.models.list("alice");
  assert.equal(list.length, 2);
  assert.ok(list.every((item) => item.source === "preset"));
  assert.doesNotMatch(JSON.stringify(list), /SECRET|localhost/);
  assert.equal((await f.models.resolve("alice", "preset:default", false)).apiKey, "SAVED_SECRET");
  entries[0].clearApiKey = true;
  await f.form.write({ presets: entries.slice(0, 1) });
  assert.equal((await f.models.resolve("alice", "preset:default", false)).apiKey, "");
  await f.form.write({ presets: [] });
  assert.deepEqual(await f.models.list("alice"), []);
});

test("personal model CRUD is account-bound, persists across reloads and keeps secrets off read APIs", async () => {
  const f = await settingsFixture();
  const input = {
    name: "Mine",
    endpoint: model.endpoint,
    model: "model-a",
    apiKey: "PERSONAL_SECRET"
  };
  await f.models.save("alice", input, false);
  const [saved] = await f.models.list("alice");
  assert.equal(saved.source, "personal");
  assert.equal(saved.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(saved), /PERSONAL_SECRET/);
  const { ModelStore } = f.load(source + "backend/settings.ts");
  const reloaded = new ModelStore(f.ctx, () => []);
  assert.equal((await reloaded.resolve("alice", saved.id, false)).apiKey, "PERSONAL_SECRET");
  assert.deepEqual(await f.models.list("bob"), []);
  const id = saved.id.split(":")[1];
  await assert.rejects(f.models.resolve("bob", saved.id, false), /AI_MODEL_MISSING/);
  await assert.rejects(f.models.save("bob", { ...input, id }, false), /AI_MODEL_MISSING/);
  await assert.rejects(f.models.remove("bob", id), /AI_MODEL_MISSING/);
  await f.models.save("alice", { ...input, id, apiKey: "", model: "model-b" }, false);
  assert.equal((await f.models.resolve("alice", saved.id, false)).apiKey, "PERSONAL_SECRET");
  await f.models.save(
    "alice",
    { ...input, id, apiKey: "", endpoint: "https://other.example/v1/chat/completions" },
    false
  );
  assert.equal((await f.models.resolve("alice", saved.id, false)).apiKey, "");
  await f.models.remove("alice", id);
  assert.deepEqual(await f.models.list("alice"), []);
});

test("list setting validation checks item shape, nested fields and maximum length", async () => {
  const f = await settingsFixture();
  const { validatePluginSettings } = f.load("common/src/plugin_contract.ts");
  const fields = f.form.fields();
  const good = {
    name: "One",
    endpoint: model.endpoint,
    model: "m",
    apiKey: "",
    clearApiKey: false
  };
  validatePluginSettings(fields, { presets: [good] });
  for (const presets of [
    "[]",
    [null],
    [[]],
    [{ ...good, model: 3 }],
    [{ ...good, clearApiKey: "yes" }],
    Array(51).fill(good)
  ])
    assert.throws(() => validatePluginSettings(fields, { presets }));
});

test("preset and personal thinking settings survive saving, listing and reloading", async () => {
  const f = await settingsFixture();
  const { validatePluginSettings } = f.load("common/src/plugin_contract.ts");
  const cases = [
    [true, "low"],
    [true, "medium"],
    [true, "high"],
    [false, "high"],
    [null, "medium"]
  ];
  const presets = cases.map(([thinkingEnabled, thinkingEffort], index) => ({
    id: `m${index}`,
    name: `Model ${index}`,
    endpoint: model.endpoint,
    model: model.model,
    apiKey: "SAVED_SECRET",
    thinkingEnabled,
    thinkingEffort
  }));
  validatePluginSettings(f.form.fields(), { presets });
  await f.form.write({ presets });
  for (const { id, ...input } of presets) await f.models.save("alice", input, false);
  // Exercise the form's empty-string representation of the service default.
  validatePluginSettings(f.form.fields(), f.form.read());
  await f.form.write(f.form.read());
  const { registerSettings } = f.load(source + "backend/settings.ts");
  const reloaded = await registerSettings(f.ctx);
  const list = await reloaded.list("alice");
  assert.equal(list.length, 10);
  assert.doesNotMatch(JSON.stringify(list), /SAVED_SECRET/);
  for (const source of ["preset", "personal"]) {
    const entries = list.filter((entry) => entry.source === source);
    for (let i = 0; i < cases.length; i++) {
      const [enabled, effort] = cases[i];
      assert.equal(entries[i].thinkingEnabled, enabled);
      assert.equal(entries[i].thinkingEffort, effort);
      const resolved = await reloaded.resolve("alice", entries[i].id, false);
      assert.equal(resolved.thinkingEnabled, enabled);
      assert.equal(resolved.thinkingEffort, effort);
      assert.equal(resolved.apiKey, "SAVED_SECRET");
    }
  }
});

test("legacy models keep provider defaults and partial edits retain saved thinking settings", async () => {
  const legacy = {
    id: "old",
    name: "Old",
    endpoint: model.endpoint,
    model: model.model,
    apiKey: ""
  };
  const f = await settingsFixture({ presets: [legacy] });
  f.data.set("EpanelPluginElementsAiPersonalModels:alice", { models: [legacy] });
  for (const entry of await f.models.list("alice")) {
    assert.equal(entry.thinkingEnabled, null);
    assert.equal(entry.thinkingEffort, "medium");
    const resolved = await f.models.resolve("alice", entry.id, false);
    assert.equal(resolved.thinkingEnabled, null);
    assert.equal(resolved.thinkingEffort, "medium");
  }
  await f.models.save("alice", { ...legacy, thinkingEnabled: true, thinkingEffort: "high" }, false);
  await f.models.save("alice", { ...legacy, name: "Renamed" }, false);
  let saved = await f.models.resolve("alice", "personal:old", false);
  assert.equal(saved.thinkingEnabled, true);
  assert.equal(saved.thinkingEffort, "high");
  await f.models.save("alice", { ...legacy, thinkingEnabled: false }, false);
  saved = await f.models.resolve("alice", "personal:old", false);
  assert.equal(saved.thinkingEnabled, false);
  assert.equal(saved.thinkingEffort, "high");
  await f.models.save("alice", { ...legacy, thinkingEnabled: null }, false);
  assert.equal((await f.models.resolve("alice", "personal:old", false)).thinkingEnabled, null);
});

test("invalid thinking values cannot overwrite preset or personal models", async () => {
  const f = await settingsFixture();
  const input = { name: "One", model: model.model, endpoint: model.endpoint };
  await f.models.save("alice", input, false);
  const [personal] = await f.models.list("alice");
  await f.form.write({ presets: [{ ...input, id: "preset" }] });
  const before = structuredClone([...f.data]);
  for (const invalid of [
    { thinkingEnabled: "false" },
    { thinkingEnabled: 1 },
    { thinkingEnabled: {} },
    { thinkingEffort: "extreme" },
    { thinkingEffort: "" },
    { thinkingEffort: null },
    { thinkingEffort: 3 }
  ]) {
    await assert.rejects(
      f.models.save("alice", { ...input, id: personal.id.slice(9), ...invalid }, false),
      /AI_INVALID_SETTINGS/
    );
    await assert.rejects(
      f.form.write({ presets: [{ ...input, id: "preset", ...invalid }] }),
      /AI_INVALID_SETTINGS/
    );
  }
  assert.deepEqual([...f.data], before);
});

test("chat preferences persist per account and reject unknown or invalid fields", async () => {
  const f = await settingsFixture();
  const { PreferencesStore } = f.load(source + "backend/preferences.ts");
  const { defaultPreferences } = f.load(source + "preferences.ts");
  const preferences = new PreferencesStore(f.ctx);
  assert.deepEqual(await preferences.read("alice"), defaultPreferences());
  const saved = {
    ...defaultPreferences(),
    sendOnEnter: false
  };
  await preferences.save("alice", saved);
  assert.deepEqual(await new PreferencesStore(f.ctx).read("alice"), saved);
  assert.deepEqual(await preferences.read("bob"), defaultPreferences());
  f.data.set("EpanelPluginElementsAiPreferences:legacy", {
    preferences: {
      ...saved,
      defaultModel: "personal:one",
      autoScroll: false,
      markdown: false,
      showDiff: false
    }
  });
  const migrated = await preferences.read("legacy");
  assert.deepEqual(migrated, saved);
  await preferences.save("legacy", migrated);
  assert.deepEqual(f.data.get("EpanelPluginElementsAiPreferences:legacy"), { preferences: saved });
  for (const value of [
    null,
    [],
    {},
    { ...saved, userId: "bob" },
    { ...saved, admin: true },
    { ...saved, markdown: "yes" },
    { ...saved, markdown: false },
    { ...saved, autoScroll: false },
    { ...saved, showDiff: false },
    { ...saved, defaultModel: "personal:one" }
  ])
    assert.throws(() => preferences.validate(value), /AI_INVALID_SETTINGS/);
});

test("parallel personal-model saves do not overwrite each other and invalid preset lists are atomic", async () => {
  const f = await settingsFixture();
  await Promise.all(
    ["A", "B"].map((name) =>
      f.models.save("alice", { name, endpoint: model.endpoint, model: name }, false)
    )
  );
  assert.equal((await f.models.list("alice")).length, 2);
  for (const presets of [
    "{}",
    "not json",
    [
      { id: "same", name: "A", endpoint: model.endpoint, model: "x" },
      { id: "same", name: "B", endpoint: model.endpoint, model: "y" }
    ],
    [null],
    Array.from({ length: 51 }, (_, i) => ({
      id: `m${i}`,
      name: "A",
      model: "x",
      endpoint: model.endpoint
    }))
  ]) {
    await assert.rejects(f.form.write({ presets }), /AI_INVALID_SETTINGS/);
  }
  assert.deepEqual(f.form.read().presets, []);
  await assert.rejects(
    f.models.save(
      "alice",
      { name: "x", model: "x", endpoint: "https://example.com", userId: "bob" },
      false
    ),
    /AI_INVALID_SETTINGS/
  );
});

test("regular personal endpoints block private IPv4, IPv6 and DNS rebinding; presets can use local models", async () => {
  const f = await settingsFixture();
  for (const host of [
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "10.0.0.1",
    "169.254.169.254",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[64:ff9b::a00:1]",
    "[fc00::1]",
    "localhost",
    "model.local"
  ]) {
    await assert.rejects(
      f.models.save(
        "alice",
        { name: "x", model: "x", endpoint: `http://${host}/v1/chat/completions` },
        false
      ),
      /AI_PUBLIC_ENDPOINT/
    );
  }
  const local = {
    name: "Local",
    model: "x",
    endpoint: "http://localhost:11434/v1/chat/completions"
  };
  await f.models.save("alice", local, true);
  const [personal] = await f.models.list("alice");
  await assert.rejects(f.models.resolve("alice", personal.id, false), /AI_PUBLIC_ENDPOINT/);
  await f.form.write({ presets: [local] });
  const preset = (await f.models.list("bob"))[0];
  assert.equal((await f.models.resolve("bob", preset.id, false)).publicOnly, false);
  const { lookupPublicAddress, modelTransport } = loader({
    dns: {
      lookup: (_host, _options, callback) =>
        callback(null, [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 }
        ])
    }
  })(source + "backend/transport.ts");
  const err = await new Promise((resolve) =>
    lookupPublicAddress("rebinding.example", {}, (error) => resolve(error))
  );
  assert.match(err.message, /Private/);
  assert.equal(modelTransport(model.endpoint, true).proxy, false);
});

test("provider streams Unicode text before completion and reconstructs fragmented tool arguments", async () => {
  const stream = new PassThrough();
  const requests = [];
  const { complete } = loader({
    axios: {
      post: async (...args) => {
        requests.push(args);
        return { data: stream, headers: { "content-type": "text/event-stream" } };
      }
    }
  })(source + "backend/provider.ts");
  const deltas = [];
  const toolRequests = [];
  let settled = false;
  const result = complete(
    model,
    [],
    [],
    new AbortController().signal,
    2000,
    async (delta) => {
      deltas.push(delta);
    },
    async (id, name) => {
      toolRequests.push({ id, name });
    }
  ).then((result) => {
    settled = true;
    return result;
  });
  const first = Buffer.from(event({ role: "assistant", content: "你好" }));
  for (const byte of first) stream.write(Buffer.from([byte]));
  await tick();
  assert.deepEqual(deltas, ["你好"]);
  assert.equal(settled, false);
  stream.write(
    event({
      tool_calls: [
        {
          index: 0,
          id: "call-1",
          type: "function",
          function: { name: "list_", arguments: '{"page":' }
        }
      ]
    })
  );
  await tick();
  assert.deepEqual(toolRequests, [{ id: "call-1", name: "list_" }]);
  assert.equal(settled, false);
  stream.write(event({ tool_calls: [{ index: 0, function: { name: "instances" } }] }));
  await tick();
  assert.deepEqual(toolRequests[1], { id: "call-1", name: "list_instances" });
  assert.equal(settled, false);
  stream.write(event({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, "tool_calls"));
  stream.end("data: [DONE]\n\n");
  const message = await result;
  assert.equal(toolRequests.length, 2);
  assert.equal(message.tool_calls[0].function.arguments, '{"page":1}');
  assert.equal(message.content, "你好");
  assert.equal(requests[0][1].stream, true);
  assert.equal(requests[0][2].responseType, "stream");
  assert.equal(requests[0][2].maxRedirects, 0);
});

test("streaming requests apply each thinking level, explicit off and provider defaults", async () => {
  const requests = [];
  const { complete } = loader({
    axios: {
      post: async (_url, body) => {
        requests.push(body);
        return {
          data: Readable.from([event({ content: "Answer" }, "stop") + "data: [DONE]\n\n"]),
          headers: { "content-type": "text/event-stream" }
        };
      }
    }
  })(source + "backend/provider.ts");
  const cases = [
    [{}, undefined],
    [{ thinkingEnabled: null, thinkingEffort: "high" }, undefined],
    [{ thinkingEnabled: false, thinkingEffort: "high" }, "none"],
    ...["low", "medium", "high"].map((effort) => [
      { thinkingEnabled: true, thinkingEffort: effort },
      effort
    ])
  ];
  for (const [settings, expected] of cases) {
    const deltas = [];
    const result = await complete(
      { ...model, ...settings },
      [],
      [],
      new AbortController().signal,
      2000,
      async (delta) => {
        deltas.push(delta);
      }
    );
    const body = requests.at(-1);
    assert.equal(body.reasoning_effort, expected);
    assert.equal(Object.hasOwn(body, "reasoning_effort"), expected !== undefined);
    assert.equal(body.stream, true);
    assert.equal(result.content, "Answer");
    assert.deepEqual(deltas, ["Answer"]);
  }
});

test("provider accepts more than eight streamed tool calls for the per-tool repetition guard", async () => {
  const toolCalls = Array.from({ length: 21 }, (_, index) => ({
    index,
    id: `call-${index}`,
    type: "function",
    function: { name: "list_instances", arguments: JSON.stringify({ page: index + 1 }) }
  }));
  const { complete } = loader({
    axios: {
      post: async () => ({
        data: Readable.from([
          ...toolCalls.map((item) => event({ tool_calls: [item] })),
          event({}, "tool_calls"),
          "data: [DONE]\n\n"
        ]),
        headers: { "content-type": "text/event-stream" }
      })
    }
  })(source + "backend/provider.ts");
  const announcements = [];
  const result = await complete(
    model,
    [],
    [],
    new AbortController().signal,
    2000,
    async () => {},
    async (id) => {
      announcements.push(id);
    }
  );
  assert.deepEqual(
    announcements,
    toolCalls.map((item) => item.id)
  );
  assert.deepEqual(
    result.tool_calls,
    toolCalls.map(({ index, ...item }) => item)
  );
});

test("provider retries transient failures five times with increasing delays and releases failed responses", async () => {
  const waits = [];
  const notices = [];
  let attempts = 0;
  let destroyed = 0;
  let checks = 0;
  const failure = { response: { status: 503, data: { destroy: () => destroyed++ } } };
  const { complete } = loader({
    axios: {
      post: async () => {
        attempts++;
        throw failure;
      }
    },
    "./retry": { waitForRetry: async (delay) => waits.push(delay) }
  })(source + "backend/provider.ts");
  await assert.rejects(
    complete(model, [], [], new AbortController().signal, 400_000, async () => {}, undefined, {
      onRetry: async (attempt, delay) => notices.push([attempt, delay]),
      beforeAttempt: async () => {
        checks++;
      }
    }),
    (error) => error.name === "ProviderError" && error.detail === "HTTP 503: Unknown provider error"
  );
  assert.equal(attempts, 6);
  assert.equal(checks, 6);
  assert.equal(destroyed, 6);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.deepEqual(
    notices,
    waits.map((delay, i) => [i + 1, delay])
  );
});

test("network, rate-limit and timeout retries can succeed while permanent errors fail immediately", async () => {
  for (const failure of [
    { code: "ECONNRESET" },
    { code: "ETIMEDOUT" },
    { code: "ECONNABORTED" },
    { response: { status: 429 } },
    { response: { status: 503 } },
    { response: { status: 400 } },
    { response: { status: 401 } },
    { response: { status: 403 } },
    { code: "ERR_UNSAFE_DOWNLOAD_URL" }
  ]) {
    let attempts = 0;
    const waits = [];
    const { complete } = loader({
      axios: {
        post: async () => {
          if (++attempts === 1) throw failure;
          return {
            data: Readable.from([event({ content: "Recovered" }, "stop") + "data: [DONE]\n\n"]),
            headers: { "content-type": "text/event-stream" }
          };
        }
      },
      "./retry": { waitForRetry: async (delay) => waits.push(delay) }
    })(source + "backend/provider.ts");
    const pending = complete(model, [], [], new AbortController().signal, 400_000, async () => {});
    if (
      [400, 401, 403].includes(failure.response?.status) ||
      failure.code === "ERR_UNSAFE_DOWNLOAD_URL"
    ) {
      await assert.rejects(
        pending,
        (error) =>
          error.name === "ProviderError" &&
          error.detail.includes(
            failure.response?.status ? `HTTP ${failure.response.status}` : failure.code
          )
      );
      assert.equal(attempts, 1);
      assert.deepEqual(waits, []);
    } else {
      assert.equal((await pending).content, "Recovered");
      assert.equal(attempts, 2);
      assert.deepEqual(waits, [1000]);
    }
  }
});

test("an internal request timeout retries cancellation errors from the HTTP client", async () => {
  let attempts = 0;
  const waits = [];
  const { complete } = loader({
    axios: {
      post: async (_url, _body, { signal }) => {
        if (++attempts === 1)
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject({ code: "ERR_CANCELED" }), {
              once: true
            });
          });
        return {
          data: Readable.from([event({ content: "Recovered" }, "stop") + "data: [DONE]\n\n"]),
          headers: { "content-type": "text/event-stream" }
        };
      }
    },
    "../timing": {
      MODEL_REQUEST_TIMEOUT_MS: 10,
      MODEL_RETRY_DELAYS_MS: [1000, 2000, 4000, 8000, 16000]
    },
    "./retry": { waitForRetry: async (delay) => waits.push(delay) }
  })(source + "backend/provider.ts");
  const controller = new AbortController();
  const result = await complete(model, [], [], controller.signal, 400_000, async () => {});
  assert.equal(result.content, "Recovered");
  assert.equal(controller.signal.aborted, false);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1000]);
});

test("stopping during backoff or failing a permission recheck prevents another model request", async () => {
  for (const revoke of [false, true]) {
    const controller = new AbortController();
    let attempts = 0;
    let allowed = true;
    const { complete } = loader({
      axios: {
        post: async () => {
          attempts++;
          throw { code: "ECONNRESET" };
        }
      },
      "./retry": {
        waitForRetry: async () => {
          if (revoke) allowed = false;
          else controller.abort();
        }
      }
    })(source + "backend/provider.ts");
    await assert.rejects(
      complete(model, [], [], controller.signal, 400_000, async () => {}, undefined, {
        beforeAttempt: async () => {
          if (!allowed) throw new Error("Permission revoked");
        }
      }),
      revoke ? /Permission revoked/ : /interrupted/
    );
    assert.equal(attempts, 1);
  }
  const { waitForRetry } = loader()(source + "backend/retry.ts");
  const controller = new AbortController();
  const pending = waitForRetry(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: "ERR_CANCELED" });
  await assert.rejects(waitForRetry(60_000, controller.signal), { code: "ERR_CANCELED" });
});

test("truncated or malformed tool streams never yield an executable tool call", async () => {
  for (const text of [
    event(
      {
        tool_calls: [
          {
            index: 0,
            id: "x",
            type: "function",
            function: { name: "create_instance", arguments: "{}" }
          }
        ]
      },
      "tool_calls"
    ),
    event(
      {
        tool_calls: [
          {
            index: 0,
            id: "x",
            type: "function",
            function: { name: "create_instance", arguments: "{" }
          }
        ]
      },
      "tool_calls"
    ) + "data: [DONE]\n\n",
    event({ content: "partial" }, "length") + "data: [DONE]\n\n",
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(
      (index) =>
        event(
          {
            tool_calls: [
              {
                index,
                id: "bad-index",
                type: "function",
                function: { name: "list_instances", arguments: "{}" }
              }
            ]
          },
          "tool_calls"
        ) + "data: [DONE]\n\n"
    )
  ]) {
    const { complete } = loader({
      axios: {
        post: async () => ({
          data: Readable.from([text]),
          headers: { "content-type": "text/event-stream" }
        })
      }
    })(source + "backend/provider.ts");
    await assert.rejects(
      complete(model, [], [], new AbortController().signal, 2000, async () => {})
    );
  }
});

test("SSE framing handles comments, CRLF boundaries, multiple data lines and bounded events", () => {
  const { SseParser } = loader()(source + "sse.ts");
  const parser = new SseParser();
  assert.deepEqual(parser.push(": hi\r"), []);
  assert.deepEqual(parser.push("\ndata: one\r\ndata: two\r"), []);
  assert.deepEqual(parser.push("\n\r\n"), ["one\ntwo"]);
  assert.throws(() => parser.push("x".repeat(260_000)), /too large/);
});

test("Koa streaming returns its body immediately and never buffers the entire generation", async () => {
  const { streamChat } = loader()(source + "backend/stream.ts");
  const headers = {};
  const request = {
    set: (key, value) => {
      headers[key] = value;
    }
  };
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  streamChat(
    request,
    async (emit) => {
      await emit({ type: "delta", index: 0, content: "first" });
      await pending;
      await emit({ type: "done", conversationId: "id" });
    },
    "failed"
  );
  assert.ok(request.body instanceof PassThrough);
  const chunks = [];
  request.body.on("data", (chunk) => chunks.push(chunk.toString()));
  await tick();
  assert.match(chunks.join(""), /first/);
  assert.doesNotMatch(chunks.join(""), /"done"/);
  assert.equal(headers["X-Accel-Buffering"], "no");
  release();
  await new Promise((resolve) => request.body.on("end", resolve));
  assert.match(chunks.join(""), /"done"/);
});
