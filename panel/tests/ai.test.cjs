const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../../../..");
const panelRequire = Module.createRequire(path.join(root, "panel/package.json"));
const ts = panelRequire("typescript");
const source = "external/epanel-plugin-elements-ai/panel/src/";

// Source-only tests: transpile into memory; no project build, listeners or AI calls.
function loader(overrides = {}) {
  const cache = new Map();
  function load(relative) {
    const filename = path.join(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename, module);
    cache.set(filename, mod);
    mod.filename = filename;
    mod.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith(".")) {
        const base = path.resolve(path.dirname(filename), id);
        if (base.endsWith(".json")) return JSON.parse(fs.readFileSync(base, "utf8"));
        for (const candidate of [base + ".ts", path.join(base, "index.ts")]) {
          if (fs.existsSync(candidate)) return load(path.relative(root, candidate));
        }
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

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const call = (name, args, id = "call-1") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
});
const answer = (content = "Done") => ({ role: "assistant", content });
const own = { daemonId: "node-a", instanceUuid: "owned" };

function fixture({
  admin = false,
  completion,
  storageData = new Map(),
  mirrorResponse,
  modResponse,
  permissionMode = "full",
  modelLoopProtection = true
} = {}) {
  const modCalls = [];
  const network = async (config) => {
    modCalls.push(config);
    assert.ok(modResponse, "Unexpected mod catalog request");
    return { data: await modResponse(config), headers: {} };
  };
  const mirrorCalls = [];
  const mirrorData = {
    "/mirrors?view=list": ["paper", "forge", "spongeforge"],
    "/mirrors/paper": { versions: ["1.21.4", "1.20.1"], description: "Paper server" },
    "/mirrors/paper/1.21.4": ["latest", "232"],
    "/download/server/paper/1.21.4?build=232": {
      url: "https://cdn.example/server.jar?signature=PRIVATE_URL",
      sha256: "a".repeat(64)
    }
  };
  const load = loader({
    axios: Object.assign(network, {
      get: async (url) => {
        const endpoint = url.replace("https://api.mslmc.cn/v4", "");
        mirrorCalls.push(endpoint);
        const data = mirrorResponse ? await mirrorResponse(endpoint) : mirrorData[endpoint];
        assert.notEqual(data, undefined, endpoint);
        return { data: { code: 200, data } };
      }
    })
  });
  const { PanelTools } = load(source + "backend/tools.ts");
  const { ChatService } = load(source + "backend/chat.ts");
  const users = new Map([
    ["alice", { uuid: "alice", userName: "Alice", permission: admin ? 10 : 1, instances: [own] }],
    [
      "bob",
      {
        uuid: "bob",
        userName: "Bob",
        permission: 1,
        instances: [{ daemonId: "node-b", instanceUuid: "owned" }]
      }
    ]
  ]);
  const nodes = new Map(
    ["node-a", "node-b"].map((uuid) => [
      uuid,
      { uuid, available: true, config: { remarks: uuid, apiKey: "NODE_SECRET" } }
    ])
  );
  const calls = [];
  const logs = [];
  const config = {
    endpoint: "https://ai.example/v1",
    model: "tool-model",
    apiKey: "PROVIDER_SECRET",
    allowUsers: true
  };
  const detail = (instanceUuid = "owned") => ({
    instanceUuid,
    status: 0,
    config: {
      nickname: "My server",
      tag: ["test"],
      type: "minecraft/java",
      cwd: "/srv/server",
      startCommand: "java -jar server.jar",
      stopCommand: "stop",
      eventTask: { autoStart: false, autoRestart: true, autoRestartMaxTimes: 3, ignore: true },
      rconPassword: "RCON_SECRET",
      docker: { env: ["SECRET=ENV_SECRET"] },
      extraServiceConfig: { openFrpToken: "FRP_SECRET" }
    }
  });
  let guard = true;
  let remoteHandler = async (event, data) => {
    if (event === "instance/section") return data.instanceUuids.map(detail);
    if (event === "instance/select") return { maxPage: 1, data: [detail()] };
    if (event === "instance/detail") return detail(data.instanceUuid);
    if (event === "instance/new")
      return { instanceUuid: "new-id", nickname: data.nickname, config: detail().config };
    return { instanceUuid: data.instanceUuid };
  };
  const ctx = {
    effect: (callback) => {
      callback();
    },
    setInterval: () => {},
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(milliseconds, 0), 1))),
    logger: { warn() {} },
    storage: {
      getStorage: () => ({
        load: async (category, Class, id) => {
          const saved = storageData.get(`${category}:${id}`);
          return saved ? Object.assign(new Class(), structuredClone(saved)) : null;
        },
        store: async (category, id, value) =>
          storageData.set(`${category}:${id}`, structuredClone(value))
      })
    },
    get: (name) => (name === "guard" ? (guard ? {} : undefined) : undefined),
    i18n: { $t: (key) => key },
    roles: { USER: 1, ADMIN: 10 },
    identity: {
      accessPolicy: { canFileManager: true },
      of: (request) => {
        const user = users.get(request.user);
        return {
          uuid: user?.uuid || "",
          userName: user?.userName || "",
          role: user?.permission || 0,
          elevated: user?.permission === 10
        };
      },
      users: { getInstance: (id) => users.get(id) },
      canAccessInstance: (request, daemonId, instanceUuid) => {
        const user = users.get(request.user);
        return (
          user?.permission === 10 ||
          !!user?.instances.some(
            (ref) => ref.daemonId === daemonId && ref.instanceUuid === instanceUuid
          )
        );
      }
    },
    remote: {
      services: { services: nodes, getInstance: (id) => nodes.get(id) },
      Request: class {
        constructor(node) {
          this.node = node;
        }
        async request(event, data) {
          calls.push({ node: this.node.uuid, event, data });
          return remoteHandler(event, data);
        }
      }
    },
    operations: { log: (type, payload) => logs.push({ type, payload }) }
  };
  const request = (body = { message: "List my servers" }, user = "alice") => ({
    user,
    // Legacy execution tests opt into full operation; approval tests omit/override it.
    request: { body: { modelId: "preset:default", permissionMode, ...body } },
    res: new EventEmitter(),
    ip: "127.0.0.1"
  });
  return {
    modCalls,
    mirrorCalls,
    ctx,
    storageData,
    config,
    users,
    nodes,
    calls,
    logs,
    request,
    load,
    tools: (user = "alice") => new PanelTools(ctx, request(undefined, user)),
    chat: new ChatService(
      ctx,
      {
        resolve: async (_user, selectionId) => ({ ...config, selectionId, publicOnly: false }),
        modelLoopProtectionEnabled: () => modelLoopProtection
      },
      completion || (async () => answer())
    ),
    remote: (handler) => {
      remoteHandler = handler;
    },
    guard: (value) => {
      guard = value;
    }
  };
}

test("regular users only enumerate their own exact node/instance pairs and no secrets", async () => {
  const f = fixture();
  const result = await f.tools().execute("list_instances", {});
  assert.equal(result.data.length, 1);
  assert.deepEqual(f.calls[0], {
    node: "node-a",
    event: "instance/section",
    data: { instanceUuids: ["owned"] }
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|startCommand|cwd|ignore/);
  assert.deepEqual((await f.tools().execute("list_instances", { daemonId: "node-b" })).data, []);
  for (const name of ["get_instance", "control_instance", "update_instance"]) {
    await assert.rejects(
      f.tools().execute(name, {
        daemonId: "node-b",
        instanceUuid: "owned",
        ...(name === "control_instance"
          ? { action: "start" }
          : name === "update_instance"
          ? { config: { tag: ["x"] } }
          : {})
      }),
      /AI_FORBIDDEN/
    );
  }
  assert.equal(f.calls.length, 1);
});

test("regular users can control their instance and patch only safe fields", async () => {
  const f = fixture();
  await f.tools().execute("control_instance", { ...own, action: "start" });
  await f.tools().execute("update_instance", {
    ...own,
    config: { eventTask: { autoRestart: true }, tag: ["prod"] }
  });
  assert.deepEqual(
    f.calls.map((entry) => entry.event),
    ["instance/open", "instance/update"]
  );
  assert.deepEqual(f.calls[1].data.config, { eventTask: { autoRestart: true }, tag: ["prod"] });
  assert.deepEqual(
    f.logs.map((entry) => entry.type),
    ["instance_start", "instance_config_change"]
  );
  assert.equal(f.logs[1].payload.operator_name, "Alice");
});

test("the assistant can start the same stopped instance twice in one turn", async () => {
  let round = 0;
  const f = fixture({
    completion: async () => {
      round++;
      if (round === 1) return call("control_instance", { ...own, action: "start" }, "start-1");
      if (round === 2) return call("get_instance", own, "check-stopped");
      if (round === 3) return call("control_instance", { ...own, action: "start" }, "start-2");
      return answer();
    }
  });
  const result = await f.chat.chat(
    f.request({ message: "Start once to generate the EULA, then start it again" })
  );
  assert.deepEqual(
    f.calls.map((entry) => entry.event),
    ["instance/open", "instance/detail", "instance/open"]
  );
  assert.deepEqual(
    f.logs.map((entry) => entry.type),
    ["instance_start", "instance_start"]
  );
  assert.equal(
    result.messages.filter((message) => message.role === "tool" && message.ok).length,
    3
  );
  assert.ok(!result.messages.some((message) => message.content.includes("AI_OPERATION_FAILED")));
});

test("forged admin tools, dangerous fields, globals and prototype keys never reach a daemon", async () => {
  const f = fixture();
  for (const name of ["create_instance", "list_nodes", "delete_instance", "request", "shell"])
    await assert.rejects(f.tools().execute(name, {}), /AI_FORBIDDEN/);
  for (const config of [
    { startCommand: "sh attack.sh" },
    { nickname: "stolen" },
    { cwd: "/" },
    { docker: { privileged: true } },
    { runAs: "root" },
    { java: { id: "x" } },
    { eventTask: { ignore: true } },
    { eventTask: { autoStart: "false" } },
    { eventTask: { autoRestartMaxTimes: -2 } },
    { tag: Array(7).fill("x") },
    { tag: [3] },
    JSON.parse('{"__proto__":{"admin":true}}'),
    JSON.parse('{"eventTask":{"constructor":{}}}')
  ])
    await assert.rejects(
      f.tools().execute("update_instance", { ...own, config }),
      /AI_INVALID_TOOL/
    );
  await assert.rejects(
    f.tools().execute("control_instance", { ...own, action: "kill" }),
    /AI_INVALID_TOOL/
  );
  await assert.rejects(
    f.tools().execute("get_instance", { ...own, instanceUuid: "global0001" }),
    /AI_FORBIDDEN/
  );
  assert.equal(f.calls.length, 0);
});

test("admins can create and configure instances; creation never auto-starts or exposes secrets", async () => {
  const f = fixture({ admin: true });
  const nodes = await f.tools().execute("list_nodes", {});
  assert.doesNotMatch(JSON.stringify(nodes), /NODE_SECRET/);
  const config = { nickname: "New", startCommand: "java -jar server.jar", cwd: "/srv/new" };
  const result = await f.tools().execute("create_instance", { daemonId: "node-b", config });
  assert.deepEqual(f.calls[0].data, { ...config, processType: "general" });
  assert.equal(result.created, true);
  assert.equal(result.started, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  await f.tools().execute("update_instance", {
    ...own,
    config: { startCommand: "java -Xmx2G -jar server.jar" }
  });
  assert.equal(f.logs[0].type, "instance_create");
  for (const invalid of [
    { ...config, cwd: "." },
    { ...config, eventTask: { autoStart: true } },
    { ...config, type: "universal/web_shell" }
  ]) {
    await assert.rejects(
      f.tools().execute("create_instance", { daemonId: "node-b", config: invalid }),
      /AI_INVALID_TOOL/
    );
  }
  assert.equal(f.calls.length, 2);
});

test("Java tools reuse the Java plugin and keep instance access scoped", async () => {
  const f = fixture({ admin: true });
  f.remote(async (event, data) => {
    if (event === "java_manager/list")
      return [
        {
          info: { fullname: "msl_21", name: "msl", version: "21", downloading: false },
          path: "/srv/java/msl_21",
          usingInstances: []
        }
      ];
    if (event === "java_manager/catalog")
      return { platform: "linux", arch: "x64", versions: ["17", "21"] };
    if (event === "java_manager/download")
      return {
        info: { fullname: "msl_21", name: "msl", version: "21", downloading: true, progress: 0 },
        path: "/srv/java/msl_21",
        usingInstances: []
      };
    if (event === "java_manager/using") return true;
    return { instanceUuid: data?.instanceUuid || "owned" };
  });
  assert.deepEqual((await f.tools().execute("list_java_runtimes", own))[0], {
    id: "msl_21",
    name: "msl",
    version: "21",
    downloading: false
  });
  assert.deepEqual(await f.tools().execute("configure_java", { ...own, javaId: "msl_21" }), {
    daemonId: "node-a",
    instanceUuid: "owned",
    javaId: "msl_21",
    configured: true
  });
  assert.deepEqual(await f.tools().execute("list_java_versions", { daemonId: "node-a" }), {
    source: "MSL",
    platform: "linux",
    arch: "x64",
    versions: ["17", "21"]
  });
  assert.equal(
    (await f.tools().execute("download_java", { daemonId: "node-a", version: "21" })).id,
    "msl_21"
  );
  f.users.get("alice").permission = 1;
  await assert.rejects(
    f.tools().execute("configure_java", { daemonId: "node-b", instanceUuid: "owned", javaId: "msl_21" }),
    /AI_FORBIDDEN/
  );
  await assert.rejects(
    f.tools().execute("download_java", { daemonId: "node-a", version: "21" }),
    /AI_FORBIDDEN/
  );
});

test("Java installation discovery checks panel runtimes before the admin-only daemon command", async () => {
  const f = fixture({ admin: true });
  const definitions = f.load(source + "backend/tools.ts").toolDefinitions;
  const adminNames = definitions(true, true).map((tool) => tool.function.name);
  const userNames = definitions(false, true).map((tool) => tool.function.name);
  assert.ok(adminNames.includes("execute_node_command"));
  assert.ok(!userNames.includes("execute_node_command"));
  assert.ok(adminNames.includes("ask_user"));
  assert.ok(userNames.includes("ask_user"));

  f.remote(async (event, data) => {
    if (event === "java_manager/list")
      return [
        {
          info: { fullname: "msl_17", name: "msl", version: "17", downloading: false }
        }
      ];
    if (event === "elements_ai/execute_command")
      return {
        platform: "linux",
        exitCode: 0,
        content: 'openjdk version "21.0.4"',
        truncated: false,
        timedOut: false
      };
    throw new Error(`Unexpected event: ${event}`);
  });

  assert.deepEqual(await f.tools().execute("list_java_runtimes", { daemonId: "node-a" }), [
    { id: "msl_17", name: "msl", version: "17", downloading: false }
  ]);
  const result = await f.tools().execute("execute_node_command", {
    daemonId: "node-a",
    command: "java -version"
  });
  assert.equal(result.daemonId, "node-a");
  assert.equal(result.platform, "linux");
  assert.equal(result.exitCode, 0);
  assert.equal(result.content, 'openjdk version "21.0.4"');
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.deepEqual(f.calls.at(-1), {
    node: "node-a",
    event: "elements_ai/execute_command",
    data: { command: "java -version", timeoutSeconds: 15, maxChars: 16000 }
  });
  assert.deepEqual(
    f.calls.map((entry) => entry.event),
    ["java_manager/list", "elements_ai/execute_command"]
  );

  const regular = fixture();
  await assert.rejects(
    regular.tools().execute("execute_node_command", {
      daemonId: "node-a",
      command: "java -version"
    }),
    /AI_FORBIDDEN/
  );
  await assert.rejects(
    f.tools().execute("execute_node_command", {
      daemonId: "node-a",
      command: "java -version\necho bad"
    }),
    /AI_INVALID_TOOL/
  );
});

test("unified download wait tool waits for Java completion and reports progress", async () => {
  const f = fixture({ admin: true });
  const definitions = f.load(source + "backend/tools.ts").toolDefinitions(true, true);
  const names = definitions.map((tool) => tool.function.name);
  assert.ok(names.includes("wait_download_task"));
  for (const name of [
    "get_java_download_status",
    "get_mod_download_status",
    "get_msl_download_status",
    "get_msl_install_status"
  ])
    assert.ok(!names.includes(name));
  let polls = 0;
  f.remote(async (event) => {
    if (event === "java_manager/download")
      return {
        info: { fullname: "msl_21", name: "msl", version: "21", downloading: true, progress: 0 },
        path: "/srv/java/msl_21",
        usingInstances: []
      };
    if (event === "java_manager/list")
      return [
        {
          info: {
            fullname: "msl_21",
            name: "msl",
            version: "21",
            downloading: polls++ === 0,
            progress: 42
          },
          path: "/srv/java/msl_21",
          usingInstances: []
        }
      ];
    return { instanceUuid: "owned" };
  });
  const receipt = await f.tools().execute("download_java", { daemonId: "node-a", version: "21" });
  assert.equal(receipt.id, "msl_21");
  const progress = [];
  const status = await f.tools().execute(
    "wait_download_task",
    { taskType: "java", daemonId: "node-a", taskId: "msl_21" },
    undefined,
    undefined,
    { waitForDownloads: true, onProgress: (value) => progress.push(value) }
  );
  assert.equal(status.state, "completed");
  assert.equal(progress.at(-1).value, 100);
  assert.ok(progress.some((value) => value.value === 42));
});

test("instance deletion tools preserve the requested directory semantics and are admin-only", async () => {
  const f = fixture({ admin: true });
  f.remote(async (event, data) => {
    if (event === "instance/delete-directory")
      return { instanceUuid: data.instanceUuid, deleted: true };
    if (event === "instance/delete")
      return { instances: [{ instanceUuid: data.instanceUuids[0], nickname: "My server" }] };
    return { instanceUuid: data?.instanceUuid || "owned" };
  });
  assert.deepEqual(
    await f.tools().execute("delete_instance_directory", own),
    { daemonId: "node-a", instanceUuid: "owned", directoryDeleted: true, instanceDeleted: false }
  );
  assert.deepEqual(await f.tools().execute("delete_instance", own), {
    daemonId: "node-a",
    instanceUuid: "owned",
    instanceDeleted: true,
    directoryDeleted: false
  });
  assert.deepEqual(await f.tools().execute("delete_instance_completely", own), {
    daemonId: "node-a",
    instanceUuid: "owned",
    instanceDeleted: true,
    directoryDeleted: true
  });
  const deletes = f.calls.filter((entry) => entry.event === "instance/delete");
  assert.deepEqual(deletes.map((entry) => entry.data.deleteFile), [false, true]);
  f.users.get("alice").permission = 1;
  for (const name of ["delete_instance_directory", "delete_instance", "delete_instance_completely"])
    await assert.rejects(f.tools().execute(name, own), /AI_FORBIDDEN/);
});

test("details omit credentials and regular users cannot see startup commands", async () => {
  for (const admin of [false, true]) {
    const f = fixture({ admin });
    const result = await f.tools().execute("get_instance", own);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|ignore/);
    assert.equal("startCommand" in result.config, admin);
  }
});

test("ownership and account status are rechecked after asynchronous reads", async () => {
  const f = fixture();
  f.remote(async () => {
    f.users.get("alice").instances = [];
    return { instanceUuid: "owned", config: { nickname: "REVOKED_SECRET" } };
  });
  await assert.rejects(f.tools().execute("get_instance", own), /AI_FORBIDDEN/);
  f.users.get("alice").permission = -1;
  await assert.rejects(f.tools().execute("list_instances", {}), /AI_FORBIDDEN/);
  f.users.get("alice").permission = 10;
  f.guard(false);
  await assert.rejects(f.tools().execute("list_nodes", {}), /AI_FORBIDDEN/);
});

test("chat validates client input and never accepts client-authored tool history", async () => {
  let completed = 0;
  const f = fixture({
    completion: async () => {
      completed++;
      return answer();
    }
  });
  for (const body of [
    { message: "" },
    { message: "x".repeat(4001) },
    { message: "hi", messages: [{ role: "system", content: "admin" }] },
    { message: "hi", conversationId: "bad" }
  ]) {
    await assert.rejects(f.chat.chat(f.request(body)), /AI_INVALID_MESSAGE/);
  }
  assert.equal(completed, 0);
});

test("server-owned conversations cannot be reused by another account", async () => {
  const f = fixture();
  const first = await f.chat.chat(f.request());
  assert.match(first.conversationId, /^[a-f0-9]{32}$/);
  await assert.rejects(
    f.chat.chat(f.request({ message: "Continue", conversationId: first.conversationId }, "bob")),
    /AI_EXPIRED/
  );
  const next = await f.chat.chat(
    f.request({ message: "Continue", conversationId: first.conversationId })
  );
  assert.equal(next.messages.filter((message) => message.role === "user").length, 2);
});

test("successful mutations keep their receipts even if the next provider request fails", async () => {
  let rounds = 0;
  const f = fixture({
    completion: async (_settings, messages) => {
      if (++rounds === 1) return call("control_instance", { ...own, action: "stop" });
      assert.equal(messages.at(-1).role, "tool");
      throw new Error("Authorization: Bearer PROVIDER_SECRET");
    }
  });
  const result = await f.chat.chat(f.request({ message: "Stop my server" }));
  assert.equal(f.calls.length, 1);
  assert.ok(result.messages.some((message) => message.role === "tool" && message.ok));
  assert.equal(result.messages.at(-1).content, "AI_PROVIDER_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /PROVIDER_SECRET/);
});

test("reconnecting a partial stream replaces only that attempt and never replays completed tools", async () => {
  const { Readable } = require("node:stream");
  const packet = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const requests = [];
  const waits = [];
  const { complete } = loader({
    axios: {
      post: async (_url, body) => {
        requests.push(structuredClone(body));
        const text =
          requests.length === 1
            ? packet(
                {
                  tool_calls: [
                    {
                      index: 0,
                      ...call("control_instance", { ...own, action: "stop" }, "completed")
                        .tool_calls[0]
                    }
                  ]
                },
                "tool_calls"
              ) + "data: [DONE]\n\n"
            : requests.length === 2
            ? packet({ content: "DISCARD_PARTIAL" }) +
              packet({
                tool_calls: [
                  {
                    index: 0,
                    id: "discarded",
                    type: "function",
                    function: { name: "control_instance", arguments: "{" }
                  }
                ]
              })
            : packet({ content: "Recovered answer" }, "stop") + "data: [DONE]\n\n";
        return { data: Readable.from([text]), headers: { "content-type": "text/event-stream" } };
      }
    },
    "./retry": { waitForRetry: async (delay) => waits.push(delay) }
  })(source + "backend/provider.ts");
  const f = fixture({ completion: complete });
  const events = [];
  const result = await f.chat.chat(f.request({ message: "Stop my server" }), async (event) =>
    events.push(structuredClone(event))
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].event, "instance/stop");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].messages, requests[2].messages);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(
    events.find((item) => item.type === "retry"),
    { type: "retry", attempt: 1, maxAttempts: 5, delayMs: 1000 }
  );
  assert.ok(events.some((item) => item.type === "delta" && item.content === "DISCARD_PARTIAL"));
  const restored = events.filter((item) => item.type === "start").at(-1).messages;
  assert.equal(restored.length, 2); // User request and the completed stop receipt.
  assert.equal(restored[1].ok, true);
  assert.equal(result.messages.filter((item) => item.role === "tool").length, 1);
  assert.equal(result.messages.at(-1).content, "Recovered answer");
  assert.doesNotMatch(JSON.stringify(result), /DISCARD_PARTIAL|discarded/);
  const [saved] = f.storageData.get("EpanelPluginElementsAiHistory:alice").entries;
  assert.doesNotMatch(JSON.stringify(saved), /DISCARD_PARTIAL|discarded/);
  assert.ok(saved.visible.every((item) => !item.pending));
});

test("role and ownership changes during model execution cannot authorize tools", async () => {
  let rounds = 0;
  const f = fixture({
    admin: true,
    completion: async () => {
      if (++rounds > 1) return answer();
      f.users.get("alice").permission = 1;
      return call("create_instance", {
        daemonId: "node-a",
        config: { nickname: "x", startCommand: "x", cwd: "/x" }
      });
    }
  });
  const result = await f.chat.chat(f.request());
  assert.equal(f.calls.length, 0);
  assert.ok(result.messages.some((message) => message.content.includes("AI_FORBIDDEN")));
});

test("duplicate call IDs fail without imposing a cumulative tool limit", async () => {
  let rounds = 0;
  const f = fixture({
    completion: async () => {
      rounds++;
      if (rounds > 3) return answer();
      return call("control_instance", { ...own, action: "restart" });
    }
  });
  const result = await f.chat.chat(f.request());
  assert.equal(f.calls.length, 1);
  assert.equal(rounds, 4);
  assert.equal(result.messages.at(-1).content, "Done");
  const receipts = result.messages.filter((message) => message.role === "tool");
  assert.equal(receipts.length, 3);
  assert.ok(receipts.slice(1).every((message) => message.content.includes("AI_INVALID_TOOL")));
});

test("repeated tool results stop a model loop without using a cumulative call limit", async () => {
  let rounds = 0;
  const f = fixture({
    completion: async () =>
      call("get_instance", own, `loop-${++rounds}`)
  });
  const result = await f.chat.chat(f.request());
  assert.equal(rounds, 6);
  assert.equal(f.calls.length, 6);
  assert.equal(result.messages.at(-1).content, "AI_MODEL_LOOP_DETECTED");
  assert.equal(result.messages.at(-1).role, "error");
  assert.ok(
    result.messages
      .filter((message) => message.role === "tool")
      .every((message) => message.ok && !message.pending)
  );
});

test("alternating tool workflows are detected as a repeating cycle", async () => {
  let rounds = 0;
  const f = fixture({
    completion: async () => {
      rounds++;
      return rounds % 2
        ? call("get_instance", own, `cycle-${rounds}`)
        : call("list_instances", {}, `cycle-${rounds}`);
    }
  });
  const result = await f.chat.chat(f.request());
  assert.equal(rounds, 12);
  assert.equal(f.calls.length, 12);
  assert.equal(result.messages.at(-1).content, "AI_MODEL_LOOP_DETECTED");
  assert.equal(result.messages.at(-1).role, "error");
});

test("model loop protection can be disabled", async () => {
  let rounds = 0;
  const f = fixture({
    modelLoopProtection: false,
    completion: async () => {
      if (++rounds > 10) return answer();
      return call("get_instance", own, `loop-${rounds}`);
    }
  });
  const result = await f.chat.chat(f.request());
  assert.equal(rounds, 11);
  assert.equal(f.calls.length, 10);
  assert.equal(result.messages.at(-1).content, "Done");
  assert.ok(!result.messages.some((message) => message.role === "error"));
});

test("mixed tools can finish after more than 8 model rounds and 16 total operations", async () => {
  let rounds = 0;
  const f = fixture({
    admin: true,
    completion: async () => {
      if (++rounds > 38) return answer();
      return rounds % 2
        ? call(
            "list_instances",
            { daemonId: own.daemonId, page: (rounds + 1) / 2 },
            `call-${rounds}`
          )
        : call("get_instance", own, `call-${rounds}`);
    }
  });
  const result = await f.chat.chat(f.request());
  assert.equal(rounds, 39);
  assert.equal(f.calls.length, 38);
  assert.equal(
    result.messages.filter((message) => message.role === "tool" && message.ok).length,
    38
  );
  assert.equal(result.messages.at(-1).content, "Done");
  assert.ok(!result.messages.some((message) => message.role === "error"));
});

test("the same read tool can run more than one hundred times in one turn", async () => {
  let rounds = 0;
  const f = fixture({
    admin: true,
    completion: async () => {
      if (++rounds > 105) return answer();
      return call(
        "list_instances",
        { daemonId: own.daemonId, page: rounds },
        `call-${rounds}`
      );
    }
  });
  const result = await f.chat.chat(f.request());
  assert.equal(rounds, 106);
  assert.equal(f.calls.length, 105);
  assert.ok(f.calls.every((entry) => entry.event === "instance/select"));
  const receipts = result.messages.filter((message) => message.role === "tool");
  assert.equal(receipts.length, 105);
  assert.ok(receipts.every((message) => message.ok && !message.pending));
  assert.equal(result.messages.at(-1).content, "Done");
  assert.ok(!result.messages.some((message) => message.role === "error"));
});

test("repeated mutations with fresh tool IDs cannot create duplicate instances", async () => {
  let rounds = 0;
  const f = fixture({
    admin: true,
    completion: async () => {
      if (++rounds > 2) return answer();
      return call(
        "create_instance",
        {
          daemonId: "node-a",
          config: { nickname: "New", cwd: "/srv/new", startCommand: "java -jar server.jar" }
        },
        `call-${rounds}`
      );
    }
  });
  await f.chat.chat(f.request());
  assert.equal(f.calls.filter((entry) => entry.event === "instance/new").length, 1);
});

test("old conversations are invalidated when account permissions or instance ownership change", async () => {
  const f = fixture();
  const first = await f.chat.chat(f.request());
  f.users.get("alice").instances = [];
  await assert.rejects(
    f.chat.chat(f.request({ message: "Continue", conversationId: first.conversationId })),
    /AI_EXPIRED/
  );
});

test("model changes preserve an existing conversation across providers", async () => {
  let requests = 0;
  const f = fixture({
    completion: async () => {
      requests++;
      return answer();
    }
  });
  const first = await f.chat.chat(f.request());
  const result = await f.chat.chat(
    f.request({
      message: "Continue",
      conversationId: first.conversationId,
      modelId: "personal:other"
    })
  );
  assert.equal(result.conversationId, first.conversationId);
  assert.equal(result.messages.filter((message) => message.role === "user").length, 2);
  assert.equal(requests, 2);
});

test("chat keeps completed reasoning and work status on the saved assistant message", async (t) => {
  const f = fixture({
    completion: async (
      _config,
      _history,
      _tools,
      _signal,
      _timeout,
      _onDelta,
      _onToolRequest,
      hooks
    ) => {
      await hooks.onReasoning("Checking the node\n");
      await hooks.onReasoning("Checking Java");
      return answer("Done");
    }
  });
  t.after(() => f.chat.dispose());
  const events = [];
  const result = await f.chat.chat(f.request({ message: "Check Java" }), async (event) => {
    events.push(event);
  });
  assert.ok(
    events.some(
      (event) =>
        event.type === "message" && event.message.reasoning === "Checking the node\nChecking Java"
    )
  );
  const assistant = result.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content, "Done");
  assert.equal(assistant.reasoning, "Checking the node\nChecking Java");
  assert.equal(assistant.reasoningComplete, true);
  assert.equal(assistant.workComplete, true);
  assert.match(
    JSON.stringify(f.storageData.get("EpanelPluginElementsAiHistory:alice")),
    /Checking the node/
  );
});

test("streamed tool receipts arrive before the final answer and personal models cannot elevate permissions", async () => {
  const waiting = deferred();
  const events = [];
  let round = 0;
  const f = fixture({
    completion: async (_config, _history, _tools, _signal, _timeout, onDelta) => {
      round++;
      if (round === 1) return call("control_instance", { ...own, action: "start" });
      if (round === 2) {
        await onDelta("Starting");
        await waiting.promise;
        return call(
          "create_instance",
          { daemonId: "node-a", config: { nickname: "x", cwd: "/x", startCommand: "x" } },
          "new-call"
        );
      }
      return answer();
    }
  });
  const result = f.chat.chat(
    f.request({ message: "Start my instance", modelId: "personal:mine" }),
    async (event) => {
      events.push(event);
    }
  );
  for (let count = 0; count < 50 && !events.some((event) => event.type === "delta"); count++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    events.some(
      (event) => event.type === "message" && event.message.role === "tool" && event.message.ok
    )
  );
  assert.ok(events.some((event) => event.type === "delta" && event.content === "Starting"));
  assert.ok(!events.some((event) => event.type === "done"));
  waiting.resolve();
  await result;
  assert.equal(f.calls.length, 1);
  assert.ok(
    events.some(
      (event) => event.type === "message" && event.message.content.includes("AI_FORBIDDEN")
    )
  );
  assert.equal(events.at(-1).type, "done");
});

test("tool requests appear before arguments finish and update the same row after execution", async () => {
  const announced = deferred();
  const argumentsReady = deferred();
  const executing = deferred();
  const operationReady = deferred();
  const events = [];
  let round = 0;
  const f = fixture({
    completion: async (_config, _history, _tools, _signal, _timeout, _onDelta, onToolRequest) => {
      if (round++) return answer();
      await onToolRequest("call-1", "control_");
      await onToolRequest("call-1", "control_instance");
      announced.resolve();
      await argumentsReady.promise;
      return call("control_instance", { ...own, action: "start" });
    }
  });
  f.remote(async () => {
    executing.resolve();
    await operationReady.promise;
    return { instanceUuid: own.instanceUuid };
  });
  const result = f.chat.chat(f.request(), async (event) => events.push(event));
  await announced.promise;
  const requests = events.filter((event) => event.type === "message");
  assert.deepEqual(
    requests.map((event) => event.message.tool),
    ["control_", "control_instance"]
  );
  assert.ok(requests.every((event) => event.index === 1 && event.message.pending));
  assert.equal(f.calls.length, 0);
  argumentsReady.resolve();
  await executing.promise;
  assert.equal(f.calls.length, 1);
  assert.equal(events.at(-1).message.pending, true);
  operationReady.resolve();
  const completed = await result;
  const updates = events.filter(
    (event) => event.type === "message" && event.message.role === "tool"
  );
  assert.equal(updates.length, 3);
  assert.equal(updates.at(-1).index, 1);
  assert.equal(updates.at(-1).message.pending, false);
  assert.equal(updates.at(-1).message.ok, true);
  assert.equal(updates[0].message.pending, true); // Published snapshots must stay unchanged.
  assert.equal(completed.messages.filter((message) => message.role === "tool").length, 1);
  const saved = await f.chat.readHistory(f.request(), completed.conversationId);
  assert.ok(saved.messages.every((message) => !message.pending));
});

test("multiple tool requests each keep their row and independent success or failure result", async () => {
  let round = 0;
  const f = fixture({
    completion: async (_config, _history, _tools, _signal, _timeout, _onDelta, onToolRequest) => {
      if (round++) return answer();
      await onToolRequest("allowed", "control_instance");
      await onToolRequest("forbidden", "create_instance");
      return {
        ...call("control_instance", { ...own, action: "start" }, "allowed"),
        tool_calls: [
          ...call("control_instance", { ...own, action: "start" }, "allowed").tool_calls,
          ...call("create_instance", {}, "forbidden").tool_calls
        ]
      };
    }
  });
  const events = [];
  const result = await f.chat.chat(f.request(), async (event) => events.push(event));
  const updates = events.filter(
    (event) => event.type === "message" && event.message.role === "tool"
  );
  assert.deepEqual(
    updates.map((event) => [event.index, event.message.pending]),
    [
      [1, true],
      [2, true],
      [1, false],
      [2, false]
    ]
  );
  const receipts = result.messages.filter((message) => message.role === "tool");
  assert.deepEqual(
    receipts.map((message) => message.ok),
    [true, false]
  );
  assert.match(receipts[1].content, /AI_FORBIDDEN/);
  assert.equal(f.calls.length, 1);
});

test("provider failure or cancellation settles announced tools without executing them", async () => {
  for (const cancelled of [false, true]) {
    const announced = deferred();
    const release = deferred();
    const f = fixture({
      completion: async (_config, _history, _tools, _signal, _timeout, _onDelta, onToolRequest) => {
        await onToolRequest("call-1", "control_instance");
        announced.resolve();
        await release.promise;
        if (!cancelled) throw new Error("PROVIDER_SECRET");
        return call("control_instance", { ...own, action: "start" });
      }
    });
    const request = f.request();
    const events = [];
    const result = f.chat.chat(request, async (event) => events.push(event));
    await announced.promise;
    if (cancelled) request.res.emit("close");
    release.resolve();
    const completed = await result;
    const updates = events.filter(
      (event) => event.type === "message" && event.message.role === "tool"
    );
    assert.equal(updates.length, 2);
    assert.equal(updates[0].message.pending, true);
    assert.equal(updates[1].index, updates[0].index);
    assert.equal(updates[1].message.pending, false);
    assert.equal(updates[1].message.ok, false);
    assert.equal(updates[1].message.content, cancelled ? "AI_INTERRUPTED" : "AI_PROVIDER_FAILED");
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(events), /PROVIDER_SECRET/);
    const saved = await f.chat.readHistory(f.request(), completed.conversationId);
    assert.ok(saved.messages.every((message) => !message.pending));
  }
});

test("concurrent requests for one user cannot duplicate operations; disposal cancels pending work", async () => {
  const pending = deferred();
  const f = fixture({ completion: () => pending.promise });
  const first = f.chat.chat(f.request());
  await assert.rejects(f.chat.chat(f.request()), /AI_BUSY/);
  f.chat.dispose();
  pending.resolve(call("control_instance", { ...own, action: "start" }));
  const result = await first;
  assert.equal(f.calls.length, 0);
  assert.ok(result.messages.some((message) => message.role === "error"));
});

test("history persists across restarts, isolates accounts and resumes server-owned context", async () => {
  const f = fixture();
  const first = await f.chat.chat(f.request({ message: "My saved conversation" }));
  const entries = await f.chat.listHistory(f.request());
  assert.equal(entries[0].title, "My saved conversation");
  assert.equal(entries[0].id, first.conversationId);
  assert.deepEqual(await f.chat.listHistory(f.request({}, "bob")), []);
  await assert.rejects(
    f.chat.readHistory(f.request({}, "bob"), first.conversationId),
    /AI_EXPIRED/
  );
  const stored = JSON.stringify([...f.storageData.values()]);
  assert.doesNotMatch(stored, /PROVIDER_SECRET|https:\/\/ai.example/);
  f.chat.dispose();
  let context;
  const restored = fixture({
    storageData: f.storageData,
    completion: async (_config, messages) => {
      context = messages;
      return answer("Continued");
    }
  });
  const detail = await restored.chat.readHistory(restored.request(), first.conversationId);
  assert.equal(detail.canContinue, true);
  assert.equal(detail.messages[0].content, "My saved conversation");
  await restored.chat.chat(
    restored.request({ message: "Follow up", conversationId: first.conversationId })
  );
  assert.ok(context.some((message) => message.content === "My saved conversation"));
  assert.equal((await restored.chat.listHistory(restored.request())).length, 1);
});

test("history deletion is limited to selected IDs in the current permission scope", async () => {
  const f = fixture();
  const { HistoryStore } = f.load(source + "backend/history.ts");
  const history = new HistoryStore(f.ctx);
  const scope = f.tools().scope();
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  const hidden = "c".repeat(32);
  const conversation = (id, valueScope = scope) => ({
    owner: "alice",
    scope: valueScope,
    model: "preset:default",
    modelName: "Default",
    title: id,
    touched: 1,
    turns: [],
    visible: []
  });
  await history.save(first, conversation(first));
  await history.save(second, conversation(second));
  await history.save(hidden, conversation(hidden, "different-scope"));
  assert.equal(await f.chat.deleteHistory(f.request(), [first, hidden]), 1);
  assert.deepEqual(
    (await f.chat.listHistory(f.request())).map((entry) => entry.id),
    [second]
  );
  await assert.rejects(f.chat.deleteHistory(f.request(), ["bad"]), /AI_INVALID_TOOL/);
  assert.equal(await f.chat.deleteHistory(f.request(), [hidden]), 0);
});

test("history rechecks ownership scopes and can resume with a changed model target", async () => {
  const f = fixture({ admin: true });
  const { conversationId } = await f.chat.chat(f.request());
  f.users.get("alice").permission = 1;
  assert.deepEqual(await f.chat.listHistory(f.request()), []);
  await assert.rejects(f.chat.readHistory(f.request(), conversationId), /AI_EXPIRED/);
  f.users.get("alice").permission = 10;
  f.config.endpoint = "https://new.example/v1";
  assert.equal((await f.chat.readHistory(f.request(), conversationId)).canContinue, true);
  const result = await f.chat.chat(f.request({ message: "Continue", conversationId }));
  assert.equal(result.messages.filter((message) => message.role === "user").length, 2);
  const original = f.ctx.storage.getStorage();
  f.ctx.storage.getStorage = () => ({
    ...original,
    load: async (...args) => {
      const value = await original.load(...args);
      f.users.get("alice").permission = 1;
      return value;
    }
  });
  await assert.rejects(f.chat.listHistory(f.request()), /AI_FORBIDDEN/);
});

test("history keeps 50 conversations per account and reports save failures without hiding results", async () => {
  const f = fixture();
  const { HistoryStore } = f.load(source + "backend/history.ts");
  const history = new HistoryStore(f.ctx);
  for (let index = 0; index < 51; index++) {
    await history.save(index.toString(16).padStart(32, "0"), {
      owner: "alice",
      scope: f.tools().scope(),
      model: "preset:default",
      modelName: "test",
      title: `Conversation ${index}`,
      touched: index,
      turns: [],
      visible: []
    });
  }
  const entries = await f.chat.listHistory(f.request());
  assert.equal(entries.length, 50);
  assert.equal(entries[0].title, "Conversation 50");
  assert.equal(entries.at(-1).title, "Conversation 1");
  const original = f.ctx.storage.getStorage();
  f.ctx.storage.getStorage = () => ({
    ...original,
    store: async () => {
      throw new Error("storage failed");
    }
  });
  const result = await f.chat.chat(f.request());
  assert.ok(result.messages.some((message) => message.content === "Done"));
  assert.equal(result.messages.at(-1).content, "AI_HISTORY_SAVE_FAILED");
});

test("terminal snapshots are bounded, strip controls and enforce ownership before and after reads", async () => {
  const f = fixture();
  f.remote(async (event) => {
    assert.equal(event, "instance/outputlog");
    return "older\n\x1b[31mError\x1b[0m\r\n\x1b]0;window title\x07Last line";
  });
  const result = await f.tools().execute("read_terminal", { ...own, lines: 2, maxChars: 100 });
  assert.equal(result.content, "Error\nLast line");
  assert.equal(result.truncated, true);
  for (const args of [
    { ...own, daemonId: "node-b" },
    { ...own, instanceUuid: "global0001" }
  ])
    await assert.rejects(f.tools().execute("read_terminal", args), /AI_FORBIDDEN/);
  for (const args of [
    { ...own, lines: 501 },
    { ...own, maxChars: 999999 },
    { ...own, command: "stop" }
  ])
    await assert.rejects(f.tools().execute("read_terminal", args), /AI_INVALID_TOOL/);
  const admin = fixture({ admin: true });
  await assert.rejects(
    admin.tools().execute("read_terminal", { ...own, instanceUuid: "../other" }),
    /AI_INVALID_TOOL/
  );
  assert.equal(admin.calls.length, 0);
  f.remote(async () => {
    f.users.get("alice").instances = [];
    return "PRIVATE OUTPUT";
  });
  await assert.rejects(f.tools().execute("read_terminal", own), /AI_FORBIDDEN/);
});

test("chat validates the current instance context before forwarding it to a model", async () => {
  let seen;
  const f = fixture({
    completion: async (_config, messages, definitions) => {
      seen = messages[0].content;
      assert.ok(definitions.some((tool) => tool.function.name === "read_terminal"));
      assert.ok(!definitions.some((tool) => tool.function.name.includes("msl")));
      return answer();
    }
  });
  await f.chat.chat(f.request({ message: "Inspect this instance", currentInstance: own }));
  assert.match(seen, /Current instance context: \{"daemonId":"node-a","instanceUuid":"owned"\}/);
  for (const currentInstance of [null, { ...own, command: "stop" }, { ...own, daemonId: "node-b" }])
    await assert.rejects(
      f.chat.chat(f.request({ message: "Read logs", currentInstance })),
      /AI_INVALID_TOOL|AI_FORBIDDEN/
    );
});

const mslSelection = { server: "paper", version: "1.21.4", build: "232" };

test("MSL indexes support discovery and pagination; only validated source links can be resolved", async () => {
  const f = fixture({ admin: true });
  const tools = f.tools();
  const servers = await tools.execute("list_msl_servers", {});
  assert.deepEqual(
    servers.items.map((item) => item.server),
    ["paper", "forge"]
  );
  assert.deepEqual(
    (await tools.execute("list_msl_versions", { server: "paper", search: "1.21" })).items,
    ["1.21.4"]
  );
  assert.deepEqual(
    (await tools.execute("list_msl_builds", { server: "paper", version: "1.21.4", page: 2 })).items,
    []
  );
  const download = await tools.execute("get_msl_download", mslSelection);
  assert.equal(download.kind, "jar");
  assert.equal(download.sha256, "a".repeat(64));
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    tools.execute("get_msl_download", { ...mslSelection, url: "http://localhost/private" }),
    /AI_INVALID_TOOL/
  );
  await assert.rejects(
    tools.execute("get_msl_download", { ...mslSelection, build: "not-in-index" })
  );
  await assert.rejects(tools.execute("list_msl_servers", { page: 0 }), /AI_INVALID_TOOL/);
  const regular = fixture();
  for (const name of f
    .load(source + "backend/msl.ts")
    .mslDefinitions.map((tool) => tool.function.name))
    await assert.rejects(regular.tools().execute(name, {}), /AI_FORBIDDEN/);
  assert.deepEqual(regular.mirrorCalls, []);
});

test("MSL creation reuses daemon installation, projects its receipt and distinguishes completion from cancellation", async () => {
  const f = fixture({ admin: true });
  let task = {
    taskId: "install-one",
    status: 1,
    detail: {
      instanceUuid: "new-id",
      downloadProgress: { percentage: 100 },
      instanceConfig: { password: "SECRET" }
    }
  };
  f.remote(async (event) => {
    if (event === "info/overview") return { features: { minecraftInstall: true } };
    if (event === "instance/asynchronous")
      return {
        instanceUuid: "new-id",
        taskId: "install-one",
        instanceConfig: { password: "SECRET" }
      };
    if (event === "instance/query_asynchronous") return [task];
    throw new Error(event);
  });
  const result = await f.tools().execute("create_msl_instance", {
    daemonId: "node-a",
    nickname: "Paper server",
    ...mslSelection,
    javaPath: "/opt/java/bin/java"
  });
  assert.equal(result.accepted, true);
  assert.equal(result.started, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_URL/);
  const sent = f.calls.find((entry) => entry.event === "instance/asynchronous").data;
  assert.equal(sent.taskName, "minecraft_install");
  assert.equal(sent.role, 10);
  assert.equal(sent.parameter.setupInfo.cwd, "");
  assert.equal(sent.parameter.setupInfo.eventTask.autoStart, false);
  assert.equal(sent.parameter.minecraft.sha256, "a".repeat(64));
  assert.equal(f.logs[0].type, "instance_create");
  const query = { daemonId: "node-a", instanceUuid: "new-id", taskId: "install-one" };
  assert.equal((await f.tools().execute("get_msl_install_status", query)).state, "running");
  task.status = 0;
  task.detail.cancelled = true;
  assert.equal((await f.tools().execute("get_msl_install_status", query)).state, "cancelled");
  task.detail.cancelled = false;
  task.detail.completed = true;
  assert.equal((await f.tools().execute("get_msl_install_status", query)).state, "completed");
  task.status = -1;
  task.detail.error = "SECRET download URL";
  assert.doesNotMatch(
    JSON.stringify(await f.tools().execute("get_msl_install_status", query)),
    /SECRET/
  );
  await assert.rejects(
    f.tools().execute("get_msl_install_status", { ...query, instanceUuid: "different" }),
    /AI_FORBIDDEN/
  );
});

test("MSL creation rejects unsupported nodes, forged settings and privilege changes during resolution", async () => {
  const f = fixture({ admin: true });
  f.remote(async () => ({ features: {} }));
  const args = { daemonId: "node-a", nickname: "Paper", ...mslSelection };
  await assert.rejects(f.tools().execute("create_msl_instance", args), /AI_MSL_UNSUPPORTED/);
  for (const extra of [
    { cwd: "/" },
    { startCommand: "sh" },
    { javaPath: 'java" -jar malicious' },
    { nickname: "__MCSM_GLOBAL_INSTANCE__" }
  ])
    await assert.rejects(
      f.tools().execute("create_msl_instance", { ...args, ...extra }),
      /AI_INVALID_TOOL/
    );
  f.remote(async () => {
    f.users.get("alice").permission = 1;
    return { features: { minecraftInstall: true } };
  });
  await assert.rejects(f.tools().execute("create_msl_instance", args), /AI_FORBIDDEN/);
  assert.ok(!f.calls.some((entry) => entry.event === "instance/asynchronous"));
});

test("MSL downloads use isolated filenames and never treat acceptance or other instance tasks as completion", async () => {
  const f = fixture({ admin: true });
  let state = { instanceFileTask: 0, downloadFileFromURLTask: 0, downloadTasks: [] };
  let files = [];
  f.remote(async (event) => {
    if (event === "instance/detail")
      return { instanceUuid: "owned", status: 0, config: { cwd: "/srv/owned" } };
    if (event === "file/status") return state;
    if (event === "file/list") return { items: files };
    if (event === "file/download_from_url") return {};
    throw new Error(event);
  });
  const result = await f.tools().execute("download_msl_server", { ...own, ...mslSelection });
  assert.match(result.path, /^msl-[a-f0-9]{24}\.jar$/);
  assert.equal(result.accepted, true);
  assert.equal(result.installed, false);
  assert.equal(f.calls.find((entry) => entry.event === "file/download_from_url").data.ifIdle, true);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.logs), /PRIVATE_URL/);
  const query = { ...own, path: result.path };
  state.downloadTasks = [{ path: `/srv/other/${result.path}`, status: 1, error: "SECRET" }];
  assert.equal((await f.tools().execute("get_msl_download_status", query)).state, "unknown");
  state.downloadTasks = [{ path: `/srv/owned/${result.path}`, status: 0, current: 10, total: 20 }];
  assert.equal((await f.tools().execute("get_msl_download_status", query)).state, "running");
  state.downloadTasks = [];
  files = [{ name: result.path, type: 1, size: 20 }];
  assert.equal((await f.tools().execute("get_msl_download_status", query)).state, "completed");
  state.downloadFileFromURLTask = 1;
  await assert.rejects(
    f.tools().execute("download_msl_server", { ...own, ...mslSelection }),
    /AI_BUSY/
  );
  assert.equal(f.calls.filter((entry) => entry.event === "file/download_from_url").length, 1);
});

test("uncertain MSL creation cannot be repeated with a fresh tool call ID", async () => {
  let round = 0;
  const args = { daemonId: "node-a", nickname: "Paper", ...mslSelection };
  const f = fixture({
    admin: true,
    completion: async () =>
      ++round < 3 ? call("create_msl_instance", args, `call-${round}`) : answer()
  });
  f.remote(async (event) => {
    if (event === "info/overview") return { features: { minecraftInstall: true } };
    if (event === "instance/asynchronous") throw new Error("SECRET connection lost");
  });
  const result = await f.chat.chat(f.request({ message: "Create a Paper server" }));
  assert.equal(f.calls.filter((entry) => entry.event === "instance/asynchronous").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("all 12 plugin catalogues contain the same complete translations", () => {
  const directory = path.join(root, source, "i18n");
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const hostLanguages = fs
    .readdirSync(path.join(root, "panel/plugins/i18n/src/languages"))
    .filter((file) => file.endsWith(".json"))
    .sort();
  assert.deepEqual(files, hostLanguages);
  const english = JSON.parse(fs.readFileSync(path.join(directory, "en_US.json")));
  for (const file of files) {
    const messages = JSON.parse(fs.readFileSync(path.join(directory, file)));
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort(), file);
    for (const value of Object.values(messages))
      assert.ok(typeof value === "string" && value.trim());
  }
});

test("HTTP routes enforce authentication and disappear when the guard plugin unloads", async (t) => {
  const { Context } = panelRequire("cordis");
  const Koa = panelRequire("koa");
  const compose = panelRequire("koa-compose");
  const load = loader();
  const { KoaService } = load("panel/plugins/server/src/backend/koa.ts");
  const plugin = load(source + "backend/index.ts");
  const f = fixture({ admin: true });
  const ctx = new Context();
  t.after(() => ctx.stop());
  const app = new Koa();
  ctx.plugin(KoaService, app);
  for (const name of ["identity", "remote", "operations", "roles"]) ctx.set(name, f.ctx[name]);
  ctx.set("i18n", { $t: (key) => key, define() {} });
  ctx.set("storage", { getStorage: () => ({ load: async () => null }) });
  ctx.set("settingsForm", { declare() {} });
  ctx.set("middleware", {
    permission:
      ({ level }) =>
      async (request, next) => {
        if (!(f.users.get(request.user)?.permission >= level)) {
          request.status = 403;
          request.body = "forbidden";
          return;
        }
        await next();
      }
  });
  const guard = ctx.plugin((scoped) => scoped.set("guard", {}));
  ctx.plugin({ ...plugin, name: "epanel-plugin-elements-ai" });
  await ctx.start();
  const dispatch = compose(app.middleware);
  const request = async (user = "alice", method = "GET", url = "/api/ai/status") => {
    const request = { ...f.request({}, user), method, path: url, query: {}, status: 200 };
    await dispatch(request);
    return request;
  };
  let status;
  for (let index = 0; index < 50; index++) {
    status = await request();
    if (status.body) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(status.body, {
    ready: false,
    admin: true,
    models: [],
    userId: "alice",
    preferences: {
      sendOnEnter: true
    }
  });
  assert.equal((await request("guest")).status, 403);
  assert.equal((await request("guest", "POST", "/api/ai/chat")).status, 403);
  assert.equal((await request("guest", "POST", "/api/ai/approvals/one")).status, 403);
  assert.equal((await request("guest", "POST", "/api/ai/questions/one")).status, 403);
  assert.equal((await request("guest", "PUT", "/api/ai/models")).status, 403);
  assert.equal((await request("guest", "PUT", "/api/ai/preferences")).status, 403);
  assert.equal((await request("guest", "DELETE", "/api/ai/models/one")).status, 403);
  assert.equal((await request("guest", "GET", "/api/ai/conversations")).status, 403);
  assert.equal((await request("guest", "GET", "/api/ai/conversations/one")).status, 403);
  guard.dispose();
  for (let index = 0; index < 50; index++) {
    status = await request();
    if (status.body === undefined) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(status.body, undefined);
});

function fileFixture(options) {
  const f = fixture(options);
  const files = new Map([
    ["server.properties", "motd=Before\nmax-players=20\n"],
    ["empty.txt", ""]
  ]);
  f.remote(async (event, data) => {
    if (event === "file/list")
      return {
        absolutePath: "/PRIVATE/INSTANCE/ROOT",
        total: files.size,
        items: [...files]
          .filter(([name]) => !data.fileName || name.includes(data.fileName))
          .map(([name, text]) => ({
            name,
            type: 1,
            size: Buffer.byteLength(text),
            time: "2026-09-27",
            secret: "MUST_NOT_LEAK"
          }))
      };
    if (event === "file/edit") {
      if (Object.hasOwn(data, "text")) {
        files.set(data.target, data.text);
        return true;
      }
      return files.get(data.target) || true;
    }
    if (event === "file/create-text") {
      if (files.has(data.target)) throw new Error("Already exists");
      files.set(data.target, data.text);
      return true;
    }
    if (event === "file/remove-file") {
      if (!files.has(data.target)) throw new Error("Missing file");
      files.delete(data.target);
      return true;
    }
    throw new Error(`Unexpected event: ${event}`);
  });
  return { ...f, files };
}

test("default mode waits for an authenticated one-time decision before deleting a file", async (t) => {
  for (const mode of [undefined, "default"]) {
    let round = 0;
    const f = fileFixture({
      completion: async () =>
        ++round === 1 ? call("delete_file", { ...own, path: "empty.txt" }) : answer()
    });
    t.after(() => f.chat.dispose());
    const notified = deferred();
    const request = f.request({ message: "Delete empty.txt", permissionMode: mode });
    const task = f.chat.chat(request, async (event) => {
      if (event.message?.approval) notified.resolve(event.message.approval);
    });
    const approval = await Promise.race([
      notified.promise,
      task.then(() => assert.fail("Expected approval"))
    ]);
    assert.match(approval.id, /^[a-f0-9]{32}$/);
    assert.deepEqual(JSON.parse(approval.arguments), { ...own, path: "empty.txt" });
    assert.equal(f.files.has("empty.txt"), true);
    assert.equal(f.calls.length, 0, "no daemon mutation occurs while waiting");
    assert.throws(
      () => f.chat.respondToApproval(f.request({}, "bob"), approval.id, { approved: true }),
      /AI_APPROVAL_EXPIRED/
    );
    for (const body of [null, {}, { approved: "true" }, { approved: true, path: "other.txt" }])
      assert.throws(
        () => f.chat.respondToApproval(f.request(), approval.id, body),
        /AI_INVALID_TOOL/
      );
    assert.equal(f.files.has("empty.txt"), true);
    f.chat.respondToApproval(f.request(), approval.id, { approved: true });
    assert.throws(
      () => f.chat.respondToApproval(f.request(), approval.id, { approved: true }),
      /AI_APPROVAL_EXPIRED/
    );
    const result = await task;
    assert.equal(f.files.has("empty.txt"), false);
    assert.equal(f.calls.filter((entry) => entry.event === "file/remove-file").length, 1);
    assert.ok(result.messages.some((message) => message.tool === "delete_file" && message.ok));
    assert.ok(result.messages.every((message) => !message.approval && !message.pending));
    assert.doesNotMatch(JSON.stringify(f.storageData.get("EpanelPluginElementsAiHistory:alice")), /"approval"/);
  }
});

test("ask_user blocks model execution until an authenticated option or custom answer arrives", async (t) => {
  let round = 0;
  const f = fixture({
    completion: async (_settings, messages) => {
      round++;
      if (round === 1)
        return call("ask_user", {
          question: "Which Java version should be used?",
          options: ["Java 17", "Java 21"]
        });
      assert.deepEqual(JSON.parse(messages.at(-1).content), { answer: "Use the system Java" });
      return answer("Continuing with the selected Java runtime.");
    }
  });
  t.after(() => f.chat.dispose());
  const notified = deferred();
  const task = f.chat.chat(f.request({ message: "Prepare Java" }), async (event) => {
    if (event.message?.question) notified.resolve(event.message.question);
  });
  const question = await Promise.race([
    notified.promise,
    task.then(() => assert.fail("Expected a blocking question"))
  ]);
  assert.match(question.id, /^[a-f0-9]{32}$/);
  assert.equal(question.question, "Which Java version should be used?");
  assert.deepEqual(question.options, ["Java 17", "Java 21"]);
  assert.equal(round, 1, "the next model request must wait for the answer");
  assert.throws(
    () => f.chat.respondToQuestion(f.request({}, "bob"), question.id, { answer: "Java 21" }),
    /AI_QUESTION_EXPIRED/
  );
  for (const body of [null, {}, { answer: "" }, { answer: "x", extra: true }])
    assert.throws(
      () => f.chat.respondToQuestion(f.request(), question.id, body),
      /AI_INVALID_TOOL/
    );
  f.chat.respondToQuestion(f.request(), question.id, { answer: "  Use the system Java  " });
  assert.throws(
    () => f.chat.respondToQuestion(f.request(), question.id, { answer: "Java 21" }),
    /AI_QUESTION_EXPIRED/
  );
  const result = await task;
  assert.equal(round, 2);
  assert.ok(result.messages.some((message) => message.tool === "ask_user" && message.ok));
  assert.ok(result.messages.every((message) => !message.question && !message.pending));
  assert.doesNotMatch(
    JSON.stringify(f.storageData.get("EpanelPluginElementsAiHistory:alice")),
    /"question"/
  );
});

test("invalid ask_user questions fail without opening an interactive prompt", async (t) => {
  const invalid = [
    { question: "Choose", options: ["same", "same"] },
    { question: "Choose", options: ["only one"] },
    { question: "", options: ["A", "B"] },
    { question: "Choose", options: ["A", "B"], extra: true }
  ];
  for (const [index, args] of invalid.entries()) {
    let round = 0;
    let prompted = false;
    const f = fixture({
      completion: async () => (++round === 1 ? call("ask_user", args) : answer())
    });
    t.after(() => f.chat.dispose());
    const result = await f.chat.chat(f.request({ message: `Invalid question ${index}` }), async (event) => {
      if (event.message?.question) prompted = true;
    });
    assert.equal(prompted, false);
    assert.match(
      result.messages.find((message) => message.tool === "ask_user").content,
      /AI_INVALID_TOOL/
    );
  }
});

test("denying a sensitive operation keeps the file and informs the model without repeating confirmation", async (t) => {
  let round = 0;
  let prompts = 0;
  const f = fileFixture({
    completion: async (_settings, messages) => {
      round++;
      if (round === 2) assert.match(messages.at(-1).content, /AI_OPERATION_DENIED/);
      return round <= 2
        ? call("delete_file", { ...own, path: "empty.txt" }, `call-${round}`)
        : answer();
    }
  });
  t.after(() => f.chat.dispose());
  const result = await f.chat.chat(
    f.request({ message: "Delete file", permissionMode: "default" }),
    async (event) => {
      if (event.message?.approval) {
        prompts++;
        assert.equal(f.calls.length, 0);
        f.chat.respondToApproval(f.request(), event.message.approval.id, { approved: false });
      }
    }
  );
  assert.equal(prompts, 1);
  assert.equal(f.files.has("empty.txt"), true);
  assert.equal(f.calls.length, 0);
  assert.match(
    result.messages.find((message) => message.role === "tool").content,
    /AI_OPERATION_DENIED/
  );
});

test("approval waits are cancelled on disconnect, unload or permission revocation", async (t) => {
  for (const reason of ["disconnect", "unload", "ownership", "files", "role"]) {
    let round = 0;
    const f = fileFixture({
      admin: reason === "role",
      completion: async () =>
        ++round === 1 ? call("delete_file", { ...own, path: "empty.txt" }) : answer()
    });
    t.after(() => f.chat.dispose());
    const request = f.request({ message: "Delete file", permissionMode: "default" });
    let approvalId;
    const result = await f.chat.chat(request, async (event) => {
      if (!event.message?.approval) return;
      approvalId = event.message.approval.id;
      if (reason === "disconnect") request.res.emit("close");
      else if (reason === "unload") f.chat.dispose();
      else {
        if (reason === "ownership") f.users.get("alice").instances = [];
        if (reason === "files") f.ctx.identity.accessPolicy.canFileManager = false;
        if (reason === "role") f.users.get("alice").permission = 1;
        assert.throws(
          () => f.chat.respondToApproval(f.request(), approvalId, { approved: true }),
          /AI_FORBIDDEN/
        );
      }
    });
    assert.equal(f.files.has("empty.txt"), true);
    assert.equal(f.calls.length, 0, reason);
    assert.ok(result.messages.every((message) => !message.approval && !message.pending));
    assert.throws(
      () => f.chat.respondToApproval(f.request(), approvalId, { approved: true }),
      /AI_APPROVAL_EXPIRED|AI_FORBIDDEN/
    );
  }
});

test("full mode skips sensitive confirmations while default reads and power controls need none", async (t) => {
  const cases = [
    {
      mode: "full",
      name: "delete_file",
      args: { ...own, path: "empty.txt" },
      event: "file/remove-file"
    },
    { mode: "default", name: "read_file", args: { ...own, path: "empty.txt" }, event: "file/edit" },
    {
      mode: "default",
      name: "control_instance",
      args: { ...own, action: "stop" },
      event: "instance/stop"
    }
  ];
  for (const value of cases) {
    let round = 0;
    let asked = false;
    const factory = value.name === "control_instance" ? fixture : fileFixture;
    const f = factory({
      completion: async () => (++round === 1 ? call(value.name, value.args) : answer())
    });
    t.after(() => f.chat.dispose());
    const result = await f.chat.chat(
      f.request({ message: "Perform operation", permissionMode: value.mode }),
      async (event) => {
        if (event.message?.approval) {
          asked = true;
          f.chat.dispose();
        }
      }
    );
    assert.equal(asked, false);
    assert.ok(f.calls.some((entry) => entry.event === value.event));
    assert.ok(result.messages.some((message) => message.role === "tool" && message.ok));
  }
});

test("full operation never elevates a regular account or bypasses file-manager restrictions", async () => {
  for (const action of ["foreign", "create", "files"]) {
    let round = 0;
    const f = fixture({
      completion: async () =>
        ++round > 1
          ? answer()
          : action === "create"
          ? call("create_instance", {
              daemonId: "node-a",
              config: { nickname: "x", cwd: "/srv/x", startCommand: "x" }
            })
          : call("delete_file", {
              ...own,
              ...(action === "foreign" ? { daemonId: "node-b" } : {}),
              path: "empty.txt"
            })
    });
    if (action === "files") f.ctx.identity.accessPolicy.canFileManager = false;
    const result = await f.chat.chat(
      f.request({ message: "Perform operation", permissionMode: "full" })
    );
    assert.equal(f.calls.length, 0);
    assert.match(
      result.messages.find((message) => message.role === "tool").content,
      /AI_FORBIDDEN/
    );
  }
  const f = fixture();
  for (const permissionMode of [true, null, "admin", {}, ["full"]])
    await assert.rejects(
      f.chat.chat(f.request({ message: "hello", permissionMode })),
      /AI_INVALID_MESSAGE/
    );
});

test("file diffs show changed lines with surrounding context and separate distant hunks", () => {
  const { fileDiff } = loader()(source + "backend/diff.ts");
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join("");
  const after = before.replace("line 2\n", "changed 2\n").replace("line 19\n", "changed 19\n");
  const diff = fileDiff("config/test.txt", before, after);
  assert.deepEqual(diff, {
    path: "config/test.txt",
    patch:
      "@@ -1,5 +1,5 @@\n line 1\n-line 2\n+changed 2\n line 3\n line 4\n line 5\n@@ -16,5 +16,5 @@\n line 16\n line 17\n line 18\n-line 19\n+changed 19\n line 20",
    truncated: false
  });
  assert.equal(fileDiff("config/test.txt", before, before).patch, "");
  assert.equal(
    fileDiff("f", "one\nthree\n", "one\ntwo\nthree\n").patch,
    "@@ -1,2 +1,3 @@\n one\n+two\n three"
  );
  assert.equal(
    fileDiff("f", "one\ntwo\nthree\n", "one\nthree\n").patch,
    "@@ -1,3 +1,2 @@\n one\n-two\n three"
  );
});

test("file diffs preserve empty files, Unicode and line-ending changes", () => {
  const { fileDiff } = loader()(source + "backend/diff.ts");
  assert.equal(fileDiff("f", "", "你好\n").patch, "@@ -0,0 +1,1 @@\n+你好");
  assert.equal(fileDiff("f", "你好\n", "").patch, "@@ -1,1 +0,0 @@\n-你好");
  assert.equal(
    fileDiff("f", "hello", "hello\n").patch,
    "@@ -1,1 +1,1 @@\n-hello\n\\ No newline at end of file\n+hello"
  );
  assert.equal(
    fileDiff("f", "hello\n", "hello").patch,
    "@@ -1,1 +1,1 @@\n-hello\n+hello\n\\ No newline at end of file"
  );
  assert.equal(fileDiff("f", "hello\r\n", "hello\n").patch, "@@ -1,1 +1,1 @@\n-hello\r\n+hello");
});

test("large diffs have bounded work and previews that fit in streamed messages", () => {
  const load = loader();
  const { fileDiff } = load(source + "backend/diff.ts");
  const { SseParser } = load(source + "sse.ts");
  for (const [before, after] of [
    ["old\n".repeat(16000), "new\n".repeat(16000)],
    ["\t".repeat(65536), "new"]
  ]) {
    const diff = fileDiff("f", before, after);
    assert.equal(diff.truncated, true);
    assert.ok(diff.patch.length <= 48000);
    assert.ok(diff.patch.split("\n").length <= 1000);
    const event = {
      type: "message",
      index: 1,
      message: { role: "tool", tool: "edit_file", ok: true, content: "{}", diff }
    };
    const encoded = JSON.stringify(event);
    assert.ok(encoded.length < 120000);
    assert.deepEqual(new SseParser().push(`data: ${encoded}\n\n`), [encoded]);
  }
});

test("file tools list, read and edit owned instance text files with hashes and audit receipts", async () => {
  const f = fileFixture();
  const tools = f.tools();
  const listing = await tools.execute("list_files", { ...own, path: "." });
  assert.equal(listing.items[0].name, "server.properties");
  assert.doesNotMatch(JSON.stringify(listing), /PRIVATE|MUST_NOT_LEAK/);
  const read = await tools.execute("read_file", { ...own, path: "./server.properties" });
  assert.match(read.content, /motd=Before/);
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    Object.hasOwn(f.calls.find((call) => call.event === "file/edit").data, "text"),
    false
  );
  let diff;
  const saved = await tools.execute(
    "edit_file",
    {
      ...own,
      path: "server.properties",
      expectedHash: read.sha256,
      content: "motd=After\nmax-players=20\n"
    },
    (value) => {
      diff = value;
    }
  );
  assert.equal(saved.updated, true);
  assert.equal(diff.path, "server.properties");
  assert.match(diff.patch, /-motd=Before\n\+motd=After/);
  assert.equal(Object.hasOwn(saved, "diff"), false);
  assert.match(f.files.get("server.properties"), /motd=After/);
  assert.equal(f.logs.at(-1).type, "instance_file_update");
  assert.equal(f.logs.at(-1).payload.file, "server.properties");
  assert.doesNotMatch(JSON.stringify(f.logs), /motd=/);
  const empty = await tools.execute("read_file", { ...own, path: "empty.txt" });
  assert.equal(empty.content, "");
  await tools.execute("edit_file", {
    ...own,
    path: "empty.txt",
    expectedHash: empty.sha256,
    content: "now populated"
  });
  assert.equal(f.files.get("empty.txt"), "now populated");
});

test("failed edits and permission changes during writes never publish a successful diff", async () => {
  for (const mode of ["conflict", "write-failure", "permission-change"]) {
    const f = fileFixture();
    const tools = f.tools();
    const read = await tools.execute("read_file", { ...own, path: "server.properties" });
    let published = false;
    if (mode === "conflict") f.files.set("server.properties", "Changed elsewhere");
    else
      f.remote(async (event, data) => {
        if (event === "file/list")
          return { items: [{ name: "server.properties", type: 1, size: read.content.length }] };
        if (!Object.hasOwn(data, "text")) return read.content;
        if (mode === "write-failure") return false;
        f.ctx.identity.accessPolicy.canFileManager = false;
        return true;
      });
    await assert.rejects(
      tools.execute(
        "edit_file",
        {
          ...own,
          path: "server.properties",
          expectedHash: read.sha256,
          content: "motd=After\n"
        },
        () => {
          published = true;
        }
      )
    );
    assert.equal(published, false);
  }
});

test("file tools reject cross-instance access, path escapes, disabled access and unknown arguments", async () => {
  const f = fileFixture();
  const tools = f.tools();
  for (const path of [
    "../secret",
    "sub/../../secret",
    "/etc/passwd",
    "\\\\server\\share",
    "C:\\secret",
    "file.txt:stream",
    "nul",
    "config\0.txt",
    "config/.. /secret"
  ]) {
    await assert.rejects(tools.execute("read_file", { ...own, path }), /AI_INVALID_TOOL/);
  }
  await assert.rejects(
    tools.execute("list_files", { ...own, daemonId: "node-b", path: "." }),
    /AI_FORBIDDEN/
  );
  await assert.rejects(
    tools.execute("list_files", { ...own, instanceUuid: "global0001", path: "." }),
    /AI_FORBIDDEN/
  );
  await assert.rejects(
    tools.execute("list_files", { ...own, path: ".", pageSize: 1000 }),
    /AI_INVALID_TOOL/
  );
  await assert.rejects(
    tools.execute("read_file", { ...own, path: "server.properties", text: "hidden write" }),
    /AI_INVALID_TOOL/
  );
  f.ctx.identity.accessPolicy.canFileManager = false;
  for (const name of ["list_files", "read_file", "edit_file", "create_file", "delete_file"])
    await assert.rejects(tools.execute(name, { ...own, path: "." }), /AI_FORBIDDEN/);
  assert.equal(f.calls.length, 0);
  const admin = fileFixture({ admin: true });
  admin.ctx.identity.accessPolicy.canFileManager = false;
  assert.equal((await admin.tools().execute("list_files", { ...own, path: "." })).items.length, 2);
});

test("edits require a fresh read and refuse concurrent changes, oversized files and binary text", async () => {
  const f = fileFixture();
  const tools = f.tools();
  await assert.rejects(
    tools.execute("edit_file", {
      ...own,
      path: "server.properties",
      expectedHash: "a".repeat(64),
      content: "overwritten"
    }),
    /AI_FILE_READ_REQUIRED/
  );
  const read = await tools.execute("read_file", { ...own, path: "server.properties" });
  f.files.set("server.properties", "Changed by another user");
  await assert.rejects(
    tools.execute("edit_file", {
      ...own,
      path: "server.properties",
      expectedHash: read.sha256,
      content: "overwritten"
    }),
    /AI_FILE_CHANGED/
  );
  assert.equal(f.files.get("server.properties"), "Changed by another user");
  assert.equal(f.calls.filter((call) => Object.hasOwn(call.data, "text")).length, 0);
  f.files.set("huge.txt", "x".repeat(65537));
  await assert.rejects(
    tools.execute("read_file", { ...own, path: "huge.txt" }),
    /AI_FILE_TEXT_ONLY/
  );
  assert.equal(
    f.calls.filter((call) => call.event === "file/edit" && call.data.target === "huge.txt").length,
    0
  );
  f.files.set("binary.bin", "\0binary");
  await assert.rejects(
    tools.execute("read_file", { ...own, path: "binary.bin" }),
    /AI_FILE_TEXT_ONLY/
  );
  await assert.rejects(
    tools.execute("edit_file", {
      ...own,
      path: "server.properties",
      expectedHash: read.sha256,
      content: "字".repeat(30000)
    }),
    /AI_FILE_TEXT_ONLY/
  );
});

test("file permissions are rechecked after reads and revoking file access also hides old history", async () => {
  const f = fileFixture();
  f.remote(async (event) => {
    if (event === "file/list") return { items: [{ name: "secret.txt", type: 1, size: 12 }] };
    f.ctx.identity.accessPolicy.canFileManager = false;
    return "PRIVATE FILE";
  });
  await assert.rejects(
    f.tools().execute("read_file", { ...own, path: "secret.txt" }),
    /AI_FORBIDDEN/
  );
  const history = fixture();
  const { conversationId } = await history.chat.chat(history.request());
  history.ctx.identity.accessPolicy.canFileManager = false;
  assert.deepEqual(await history.chat.listHistory(history.request()), []);
  await assert.rejects(history.chat.readHistory(history.request(), conversationId), /AI_EXPIRED/);
});

test("chat exposes permitted file tools and streams an edit receipt after reading the file", async () => {
  let round = 0;
  const f = fileFixture({
    completion: async (_config, messages, definitions) => {
      assert.ok(definitions.some((tool) => tool.function.name === "edit_file"));
      if (round++ === 0)
        return call("read_file", { ...own, path: "server.properties" }, "file-read");
      if (round === 2) {
        const read = JSON.parse(messages.find((message) => message.role === "tool").content);
        return call(
          "edit_file",
          {
            ...own,
            path: "server.properties",
            expectedHash: read.sha256,
            content: read.content.replace("motd=Before", "motd=Updated")
          },
          "file-edit"
        );
      }
      const receipt = messages.filter((message) => message.role === "tool").at(-1);
      assert.equal(Object.hasOwn(JSON.parse(receipt.content), "diff"), false);
      return answer("File updated");
    }
  });
  const events = [];
  await f.chat.chat(
    f.request({ message: "Change motd to Updated in server.properties" }),
    async (event) => events.push(event)
  );
  assert.match(f.files.get("server.properties"), /motd=Updated/);
  assert.ok(
    events.some(
      (event) => event.type === "message" && event.message.tool === "edit_file" && event.message.ok
    )
  );
  const updates = events.filter(
    (event) => event.type === "message" && event.message.tool === "edit_file"
  );
  assert.equal(updates[0].message.pending, true);
  assert.equal(updates[0].message.diff, undefined);
  assert.equal(updates.at(-1).index, updates[0].index);
  const diff = updates.at(-1).message.diff;
  assert.equal(diff.path, "server.properties");
  assert.match(diff.patch, /-motd=Before\n\+motd=Updated/);
  const [saved] = await f.chat.listHistory(f.request());
  const detail = await f.chat.readHistory(f.request(), saved.id);
  assert.ok(detail.messages.some((message) => message.tool === "edit_file" && message.ok));
  assert.deepEqual(detail.messages.find((message) => message.tool === "edit_file").diff, diff);
});

test("file create and delete enforce permissions, validate inputs and log completed operations", async () => {
  const f = fileFixture();
  const tools = f.tools();
  const result = await tools.execute("create_file", { ...own, path: "new.txt", content: "Hello" });
  assert.equal(result.created, true);
  assert.equal(f.files.get("new.txt"), "Hello");
  assert.equal(f.logs.at(-1).type, "instance_file_update");
  await assert.rejects(
    tools.execute("create_file", { ...own, path: "new.txt", content: "Overwrite" })
  );
  assert.equal(f.files.get("new.txt"), "Hello");
  assert.equal(f.logs.length, 1);
  await tools.execute("create_file", { ...own, path: "blank.txt", content: "" });
  assert.equal(f.files.get("blank.txt"), "");
  const removed = await tools.execute("delete_file", { ...own, path: "new.txt" });
  assert.equal(removed.deleted, true);
  assert.equal(f.files.has("new.txt"), false);
  assert.equal(f.logs.at(-1).type, "instance_file_delete");
  assert.equal(f.logs.at(-1).payload.file, "new.txt");
  const count = f.calls.length;
  for (const name of ["create_file", "delete_file"]) {
    const extra = name === "create_file" ? { content: "" } : {};
    await assert.rejects(
      tools.execute(name, { ...own, ...extra, path: "../outside" }),
      /AI_INVALID_TOOL/
    );
    await assert.rejects(tools.execute(name, { ...own, ...extra, path: "." }), /AI_INVALID_TOOL/);
    await assert.rejects(
      tools.execute(name, { ...own, ...extra, path: "blank.txt", daemonId: "node-b" }),
      /AI_FORBIDDEN/
    );
    await assert.rejects(
      tools.execute(name, { ...own, ...extra, path: "blank.txt", instanceUuid: "global0001" }),
      /AI_FORBIDDEN/
    );
  }
  await assert.rejects(
    tools.execute("delete_file", { ...own, path: "blank.txt", recursive: true }),
    /AI_INVALID_TOOL/
  );
  await assert.rejects(
    tools.execute("create_file", { ...own, path: "binary", content: "\0" }),
    /AI_FILE_TEXT_ONLY/
  );
  await assert.rejects(
    tools.execute("create_file", { ...own, path: "huge", content: "x".repeat(65537) }),
    /AI_FILE_TEXT_ONLY/
  );
  assert.equal(f.calls.length, count);
});

test("chat streams create/delete receipts and prevents repeated file mutations with new call IDs", async () => {
  let round = 0;
  const f = fileFixture({
    completion: async (_config, _messages, definitions) => {
      assert.ok(definitions.some((tool) => tool.function.name === "create_file"));
      assert.ok(definitions.some((tool) => tool.function.name === "delete_file"));
      const index = round++;
      if (index < 2)
        return call(
          "create_file",
          { ...own, path: "temporary.txt", content: "temporary" },
          `create-${index}`
        );
      if (index < 4)
        return call("delete_file", { ...own, path: "temporary.txt" }, `delete-${index}`);
      return answer("Finished");
    }
  });
  const events = [];
  await f.chat.chat(
    f.request({ message: "Create temporary.txt containing temporary, then delete it." }),
    async (event) => events.push(event)
  );
  assert.equal(f.calls.filter((entry) => entry.event === "file/create-text").length, 1);
  assert.equal(f.calls.filter((entry) => entry.event === "file/remove-file").length, 1);
  for (const name of ["create_file", "delete_file"]) {
    const receipts = events.filter(
      (event) => event.type === "message" && event.message.tool === name && !event.message.pending
    );
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].message.ok, true);
    assert.equal(receipts[1].message.ok, false);
  }
  const uncertain = fileFixture();
  uncertain.remote(async () => {
    throw new Error("Disconnected");
  });
  await assert.rejects(uncertain.tools().execute("delete_file", { ...own, path: "empty.txt" }));
  assert.equal(uncertain.logs.length, 0);
});

const modSelection = { source: "modrinth", projectId: "project", versionId: "version1" };
const modTaskId = "11111111-1111-4111-8111-111111111111";
const modVersion = () => ({
  id: "version1",
  project_id: "project",
  name: "Example 1.0",
  version_number: "1.0",
  game_versions: ["1.21.1"],
  loaders: ["fabric"],
  dependencies: [{ project_id: "fabric-api", dependency_type: "required" }],
  files: [
    {
      filename: "example.jar",
      primary: true,
      size: 10,
      url: "https://cdn.modrinth.com/data/project/versions/version1/example.jar?token=PRIVATE_URL"
    },
    {
      filename: "example-sources.jar",
      url: "https://cdn.modrinth.com/data/project/versions/version1/example-sources.jar"
    }
  ]
});

function modFixture(options = {}) {
  const versions = options.versions || [modVersion()];
  const f = fixture({
    ...options,
    modResponse:
      options.modResponse ||
      (async ({ url }) => {
        if (url.endsWith("/tag/game_version"))
          return [
            { project_type: "minecraft", version: "1.21.1" },
            { project_type: "minecraft", version: "1.20.1" }
          ];
        if (url.endsWith("/search"))
          return {
            total_hits: 1,
            hits: [
              {
                project_id: "project",
                title: "Example",
                description: "Description",
                project_type: "mod",
                categories: ["fabric"],
                downloads: 100
              }
            ]
          };
        if (url.endsWith("/project/project/version")) return versions;
        if (url.endsWith("/project/project")) return { project_type: "mod" };
        assert.fail(`Unexpected catalog request: ${url}`);
      })
  });
  let installPolls = 0;
  f.remote(async (event, data) => {
    if (event === "info/overview") return { features: { modInstallTasks: true } };
    if (event === "instance/mods/install_task") return { accepted: true, taskId: modTaskId };
    if (event === "instance/mods/install_status") {
      installPolls++;
      return {
        taskId: data.taskId,
        state: installPolls === 1 ? "running" : "completed",
        path: "mods/example.jar",
        downloadedBytes: installPolls === 1 ? 5 : 10,
        totalBytes: 10
      };
    }
    assert.fail(event);
  });
  return f;
}

test("mod tools reuse the built-in catalog, paginate/filter and return bounded data without URLs", async () => {
  const f = modFixture({
    versions: [modVersion(), { ...modVersion(), id: "older", game_versions: ["1.20.1"] }]
  });
  const tools = f.tools();
  assert.deepEqual(
    (await tools.execute("list_mod_game_versions", { search: "1.21", limit: 1 })).items,
    ["1.21.1"]
  );
  const results = await tools.execute("search_mods", {
    query: "example",
    source: "modrinth",
    gameVersion: "1.21.1",
    loader: "fabric"
  });
  assert.equal(results.items[0].projectId, "project");
  assert.equal(results.items[0].source, "modrinth");
  const search = f.modCalls.find((item) => item.url.endsWith("/search"));
  assert.match(search.params.facets, /versions:1.21.1/);
  assert.match(search.params.facets, /categories:Fabric/);
  assert.match(search.params.facets, /server_side:required/);
  const versions = await tools.execute("list_mod_versions", {
    source: "modrinth",
    projectId: "project",
    gameVersion: "1.21.1",
    loader: "fabric",
    limit: 1
  });
  assert.equal(versions.total, 1);
  assert.equal(versions.items[0].versionId, "version1");
  assert.equal(versions.items[0].dependencies[0].projectId, "fabric-api");
  assert.equal(versions.items[0].files[0].fileName, "example.jar");
  assert.doesNotMatch(JSON.stringify(versions), /https:|PRIVATE_URL/);
  assert.equal(
    (
      await tools.execute("list_mod_versions", {
        source: "modrinth",
        projectId: "project",
        loader: "forge"
      })
    ).total,
    0
  );
});

test("mod downloads resolve exact catalog selections and never substitute another classifier as a fallback", async () => {
  const f = modFixture();
  const result = await f.tools().execute("download_mod", { ...own, ...modSelection });
  assert.equal(result.accepted, true);
  assert.equal(result.loaded, false);
  assert.equal(result.taskId, modTaskId);
  const install = f.calls.find((item) => item.event === "instance/mods/install_task");
  assert.equal(install.node, "node-a");
  assert.equal(install.data.instanceUuid, "owned");
  assert.equal(install.data.url, modVersion().files[0].url);
  assert.equal(install.data.fallbackUrl, undefined);
  assert.equal(install.data.overwrite, false);
  assert.equal(install.data.type, "mod");
  assert.equal(f.logs[0].type, "instance_file_download_from_url");
  assert.doesNotMatch(JSON.stringify([result, f.logs]), /PRIVATE_URL|RCON_SECRET/);
  const status = await f.tools().execute("get_mod_download_status", { ...own, taskId: modTaskId });
  assert.equal(status.state, "running");
  assert.equal(status.downloadedBytes, 5);
});

test("batch mod downloads serialize node tasks and continue after a failed item", async () => {
  const f = modFixture();
  const taskIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  let submitted = 0;
  const polls = new Map();
  f.remote(async (event, data) => {
    if (event === "info/overview") return { features: { modInstallTasks: true } };
    if (event === "instance/mods/install_task")
      return { accepted: true, taskId: taskIds[submitted++] };
    if (event === "instance/mods/install_status") {
      const count = (polls.get(data.taskId) || 0) + 1;
      polls.set(data.taskId, count);
      return {
        taskId: data.taskId,
        state: count === 1 ? "running" : data.taskId === taskIds[0] ? "completed" : "failed",
        path: "mods/example.jar",
        error: data.taskId === taskIds[1] && count > 1 ? "download_failed" : undefined
      };
    }
    assert.fail(event);
  });
  const result = await f.tools().execute("download_mod_batch", {
    ...own,
    items: [modSelection, { ...modSelection, fileName: "example-sources.jar" }]
  });
  assert.equal(result.submitted, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(
    f.calls
      .filter(
        (entry) =>
          entry.event === "instance/mods/install_task" ||
          entry.event === "instance/mods/install_status"
      )
      .map((entry) => `${entry.event}:${entry.data.taskId || ""}`),
    [
      "instance/mods/install_task:",
      `instance/mods/install_status:${taskIds[0]}`,
      `instance/mods/install_status:${taskIds[0]}`,
      "instance/mods/install_task:",
      `instance/mods/install_status:${taskIds[1]}`,
      `instance/mods/install_status:${taskIds[1]}`
    ]
  );
});

test("batch mod downloads stop after an unknown task", async () => {
  const f = modFixture();
  let submitted = 0;
  f.remote(async (event, data) => {
    if (event === "info/overview") return { features: { modInstallTasks: true } };
    if (event === "instance/mods/install_task")
      return {
        accepted: true,
        taskId: `33333333-3333-4333-8333-33333333333${submitted++}`
      };
    if (event === "instance/mods/install_status") return { taskId: data.taskId, state: "unknown" };
    assert.fail(event);
  });
  const result = await f.tools().execute("download_mod_batch", {
    ...own,
    items: [modSelection, { ...modSelection, fileName: "example-sources.jar" }]
  });
  assert.equal(result.submitted, 1);
  assert.equal(result.stopped, "unknown");
  assert.equal(f.calls.filter((entry) => entry.event === "instance/mods/install_task").length, 1);
  await assert.rejects(
    f.tools().execute("download_mod_batch", {
      ...own,
      items: [{ ...modSelection, daemonId: "node-b" }]
    }),
    /AI_INVALID_TOOL/
  );
});

test("batch mod downloads honor cancellation while waiting for a task", async () => {
  const f = modFixture();
  const controller = new AbortController();
  const tools = f.tools();
  tools.signal = controller.signal;
  f.remote(async (event, data) => {
    if (event === "info/overview") return { features: { modInstallTasks: true } };
    if (event === "instance/mods/install_task") return { accepted: true, taskId: modTaskId };
    if (event === "instance/mods/install_status") return { taskId: data.taskId, state: "running" };
    assert.fail(event);
  });
  const pending = tools.execute("download_mod_batch", {
    ...own,
    items: [modSelection]
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /AI_INTERRUPTED/);
});

test("plugin loaders choose plugins while hybrid destination and overwrite are explicit", async () => {
  const f = modFixture({ versions: [{ ...modVersion(), loaders: ["paper"] }] });
  await f.tools().execute("download_mod", { ...own, ...modSelection });
  assert.equal(f.calls.at(-1).data.type, "plugin");
  await f.tools().execute("download_mod", {
    ...own,
    ...modSelection,
    projectType: "mod",
    overwrite: true,
    fileName: "example-sources.jar"
  });
  assert.equal(f.calls.at(-1).data.type, "mod");
  assert.equal(f.calls.at(-1).data.overwrite, true);
  assert.equal(f.calls.at(-1).data.fileName, "example-sources.jar");
});

test("CurseForge and SpigotMC use the built-in version mapping and same-artifact mirrors", async () => {
  for (const source of ["curseforge", "spigotmc"]) {
    const f = modFixture({
      modResponse: async ({ url }) => {
        if (url.endsWith("/v1/cf/mods/123")) return { data: { name: "Example", classId: 12 } };
        if (url.endsWith("/v1/cf/mods/123/files"))
          return {
            data: [
              {
                id: 456,
                fileName: "example.jar",
                gameVersions: ["Paper", "1.21.1"],
                downloadUrl: "https://mediafilez.forgecdn.net/files/456/example.jar"
              }
            ]
          };
        if (url.endsWith("/resources/123")) return { name: "Example" };
        if (url.endsWith("/resources/123/versions")) return [{ id: 456, name: "1.0" }];
        assert.fail(url);
      }
    });
    const list = await f.tools().execute("list_mod_versions", { source, projectId: "123" });
    assert.equal(list.items[0].versionId, "456");
    assert.equal(list.items[0].projectType, "plugin");
    await f.tools().execute("download_mod", { ...own, source, projectId: "123", versionId: "456" });
    const payload = f.calls.at(-1).data;
    assert.equal(payload.type, "plugin");
    if (source === "spigotmc") {
      assert.match(payload.url, /^https:\/\/cdn.spiget.org\//);
      assert.match(payload.fallbackUrl, /^https:\/\/api.spiget.org\//);
    } else assert.equal(payload.fallbackUrl, undefined);
  }
});

test("mod tools enforce ownership and file policy before catalog or daemon requests", async () => {
  const f = modFixture();
  for (const target of [
    { ...own, daemonId: "node-b" },
    { ...own, instanceUuid: "global0001" }
  ]) {
    await assert.rejects(
      f.tools().execute("download_mod", { ...target, ...modSelection }),
      /AI_FORBIDDEN/
    );
    await assert.rejects(f.tools().execute("list_installed_mods", target), /AI_FORBIDDEN/);
    await assert.rejects(
      f.tools().execute("get_mod_download_status", { ...target, taskId: modTaskId }),
      /AI_FORBIDDEN/
    );
  }
  f.ctx.identity.accessPolicy.canFileManager = false;
  await assert.rejects(f.tools().execute("search_mods", { query: "example" }), /AI_FORBIDDEN/);
  await assert.rejects(
    f.tools().execute("download_mod", { ...own, ...modSelection }),
    /AI_FORBIDDEN/
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.modCalls.length, 0);
  const definitions = f.load(source + "backend/tools.ts").toolDefinitions;
  assert.ok(!definitions(false, false).some((entry) => entry.function.name === "download_mod"));
  assert.ok(definitions(false, true).some((entry) => entry.function.name === "download_mod"));
});

test("mod downloads recheck permissions and cancellation after catalog and node waits", async () => {
  for (const change of ["ownership", "files", "abort"]) {
    const f = modFixture();
    const tools = f.tools();
    const controller = new AbortController();
    tools.signal = controller.signal;
    f.remote(async () => {
      if (change === "ownership") f.users.get("alice").instances = [];
      if (change === "files") f.ctx.identity.accessPolicy.canFileManager = false;
      if (change === "abort") controller.abort();
      return { features: { modInstallTasks: true } };
    });
    await assert.rejects(
      tools.execute("download_mod", { ...own, ...modSelection }),
      /AI_FORBIDDEN|AI_INTERRUPTED/
    );
    assert.equal(f.calls.filter((item) => item.event === "instance/mods/install_task").length, 0);
  }
  const waiting = deferred();
  const f = modFixture({ modResponse: () => waiting.promise });
  const pending = f.tools().execute("download_mod", { ...own, ...modSelection });
  f.users.get("alice").instances = [];
  waiting.resolve([]);
  await assert.rejects(pending, /AI_FORBIDDEN/);
  assert.equal(f.calls.length, 0);
});

test("mod download rejects fabricated IDs, paths, URLs and unsupported nodes", async () => {
  const f = modFixture();
  for (const extra of [
    { versionId: "missing" },
    { fileName: "../outside.jar" },
    { fileName: "missing.jar" },
    { url: "https://attacker.example/test.jar" },
    { source: "unknown" },
    { overwrite: "true" },
    { projectId: "../project" },
    { projectType: "resourcepack" }
  ])
    await assert.rejects(
      f.tools().execute("download_mod", { ...own, ...modSelection, ...extra }),
      /AI_INVALID_TOOL/
    );
  assert.equal(f.calls.length, 0);
  for (const url of [
    "http://127.0.0.1/private",
    "https://cdn.modrinth.com.attacker.example/a.jar",
    "https://user:pass@cdn.modrinth.com/a.jar"
  ]) {
    const f = modFixture({
      versions: [{ ...modVersion(), files: [{ filename: "example.jar", url }] }]
    });
    await assert.rejects(
      f.tools().execute("download_mod", { ...own, ...modSelection }),
      /AI_INVALID_TOOL/
    );
    assert.equal(f.calls.length, 0);
  }
  f.remote(async () => ({ features: { modManager: true } }));
  await assert.rejects(
    f.tools().execute("download_mod", { ...own, ...modSelection }),
    /AI_MOD_UNSUPPORTED/
  );
  assert.equal(f.calls.length, 1);
});

test("installed mod and task projections hide unrelated transfers and raw errors", async () => {
  const f = modFixture();
  f.remote(async (event) =>
    event === "instance/mods/list"
      ? {
          mods: [
            {
              name: "Example",
              file: "example.jar",
              enabled: false,
              version: "1",
              folder: "mods",
              type: "mod",
              secret: "PRIVATE"
            }
          ],
          folders: ["mods"],
          total: 1,
          downloadTasks: [{ path: "/other/private.jar", error: "PRIVATE" }]
        }
      : {
          taskId: modTaskId,
          state: "failed",
          error: "https://PRIVATE_URL/",
          path: "/other/private.jar",
          downloadTasks: ["PRIVATE"]
        }
  );
  const mods = await f.tools().execute("list_installed_mods", own);
  assert.equal(mods.items[0].enabled, false);
  assert.equal(mods.items[0].fileName, "example.jar");
  const status = await f.tools().execute("get_mod_download_status", { ...own, taskId: modTaskId });
  assert.equal(status.state, "failed");
  assert.doesNotMatch(JSON.stringify([mods, status]), /PRIVATE|private|downloadTasks/);
});

test("chat streams mod download requests and blocks duplicate mutations with new call IDs", async () => {
  let round = 0;
  const f = modFixture({
    completion: async () =>
      ++round <= 2
        ? call("download_mod", { ...own, ...modSelection }, `mod-${round}`)
        : answer("Download submitted")
  });
  const events = [];
  await f.chat.chat(f.request({ message: "Download the selected mod" }), async (event) =>
    events.push(event)
  );
  assert.equal(f.calls.filter((item) => item.event === "instance/mods/install_task").length, 1);
  const receipts = events.filter(
    (event) => event.type === "message" && event.message.tool === "download_mod"
  );
  assert.equal(receipts[0].message.pending, true);
  assert.equal(receipts.find((event) => event.message.ok)?.message.ok, true);
  assert.equal(receipts.at(-1).message.ok, false);
});
