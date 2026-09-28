const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../../../..");
const daemonRequire = Module.createRequire(path.join(root, "daemon/package.json"));
const ts = daemonRequire("typescript");

function load(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.require = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.startsWith(".")) {
      const file = path.resolve(path.dirname(filename), id + ".ts");
      return load(path.relative(root, file), overrides);
    }
    return daemonRequire(id);
  };
  mod._compile(
    ts.transpileModule(syncFs.readFileSync(filename, "utf8"), {
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

const runtime = {
  $t: (key) => key,
  settings: () => ({ config: { language: "en_us" } })
};

test("MSL idle-only download requests cannot interrupt an existing daemon download", async () => {
  const handlers = new Map();
  const errors = [];
  const responses = [];
  const downloads = {
    downloadingCount: 1,
    calls: 0,
    downloadFromUrl: async () => {
      downloads.calls++;
      downloads.downloadingCount = 1;
    }
  };
  const protocol = {
    use() {},
    on: (name, handler) => handlers.set(name, handler),
    response: (_ctx, data) => responses.push(data),
    responseError: (_ctx, error) => errors.push(error)
  };
  load("daemon/plugins/file/src/backend/file_router.ts", {
    "./runtime": {
      ...runtime,
      protocol: () => protocol,
      transfer: () => ({ downloads }),
      settings: () => ({ config: { maxDownloadFromUrlFileCount: 0 } })
    },
    "./file_service": {
      getFileManager: () => ({
        checkPath: () => true,
        toAbsolutePath: (name) => `/srv/instance/${name}`
      })
    },
    "./upload_manager": {},
    "./url": { checkSafeUrl: () => true }
  }).registerFileEvents();
  const request = {
    instanceUuid: "owned",
    fileName: "msl-new.jar",
    url: "https://cdn.example/server.jar",
    ifIdle: true
  };
  await handlers.get("file/download_from_url")({}, request);
  assert.equal(errors.length, 1);
  assert.equal(downloads.calls, 0);
  downloads.downloadingCount = 0;
  await handlers.get("file/download_from_url")({}, request);
  assert.equal(downloads.calls, 1);
  assert.equal(responses.length, 1);
  await handlers.get("file/download_from_url")({}, request);
  assert.equal(downloads.calls, 1);
  assert.equal(errors.length, 2);
});
const FileManager = load("daemon/plugins/file/src/backend/system_file.ts", {
  "./runtime": runtime,
  "mcsmanager-common": { ProcessWrapper: class {} }
}).default;

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-plugin-elements-ai-files-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const instance = path.join(directory, "instance");
  await fs.mkdir(instance);
  return { directory, instance, manager: new FileManager(instance, "utf-8") };
}

test("daemon creates text exclusively, preserves existing content and never recursively deletes", async (t) => {
  const { instance, manager } = await workspace(t);
  assert.equal(await manager.createTextFile("new.txt", "你好\n"), true);
  assert.equal(await fs.readFile(path.join(instance, "new.txt"), "utf8"), "你好\n");
  await assert.rejects(manager.createTextFile("new.txt", "replaced"), /EEXIST/);
  assert.equal(await fs.readFile(path.join(instance, "new.txt"), "utf8"), "你好\n");
  await manager.createTextFile("empty.txt", "");
  assert.equal((await fs.stat(path.join(instance, "empty.txt"))).size, 0);
  const race = await Promise.allSettled([
    manager.createTextFile("race.txt", "one"),
    manager.createTextFile("race.txt", "two")
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  await fs.mkdir(path.join(instance, "folder"));
  await fs.writeFile(path.join(instance, "folder/keep.txt"), "keep");
  await assert.rejects(manager.removeFile("folder"), /regular file/);
  assert.equal(await fs.readFile(path.join(instance, "folder/keep.txt"), "utf8"), "keep");
  assert.equal(await manager.removeFile("new.txt"), true);
  await assert.rejects(fs.stat(path.join(instance, "new.txt")), /ENOENT/);
  await assert.rejects(manager.removeFile("new.txt"));
  await assert.rejects(manager.createTextFile("missing/child.txt", ""), /ENOENT/);
});

test("daemon single-file actions reject escaping paths and symlinks and respect file encoding", async (t) => {
  const { directory, instance, manager } = await workspace(t);
  await fs.writeFile(path.join(directory, "outside.txt"), "outside");
  await fs.symlink(path.join(directory, "outside.txt"), path.join(instance, "link.txt"));
  await fs.symlink(directory, path.join(instance, "escape"));
  for (const target of ["../outside.txt", "link.txt", "escape/outside.txt"]) {
    await assert.rejects(manager.createTextFile(target, "overwrite"));
    await assert.rejects(manager.removeFile(target));
  }
  await assert.rejects(manager.createTextFile("escape/new.txt", "outside"));
  await manager.createTextFile("inside.txt", "inside");
  await fs.symlink(path.join(instance, "inside.txt"), path.join(instance, "internal-link.txt"));
  await assert.rejects(manager.removeFile("internal-link.txt"), /regular file/);
  await assert.rejects(manager.createTextFile("internal-link.txt", "overwrite"));
  assert.equal(await fs.readFile(path.join(directory, "outside.txt"), "utf8"), "outside");
  const encoded = new FileManager(instance, "utf-16le");
  await encoded.createTextFile("encoded.txt", "Hello");
  assert.equal(
    (await fs.readFile(path.join(instance, "encoded.txt"))).toString("utf16le"),
    "Hello"
  );
  await assert.rejects(encoded.createTextFile("oversize.txt", "a".repeat(65536)), /64 KiB/);
});

test("daemon file mutation routes wait for completion and report failures rather than premature success", async () => {
  const handlers = new Map();
  const responses = [];
  const errors = [];
  let finish;
  let pending;
  const manager = {
    createTextFile: () => pending,
    removeFile: () => pending
  };
  const protocol = {
    use() {},
    on: (event, handler) => handlers.set(event, handler),
    response: (_ctx, value) => responses.push(value),
    responseError: (_ctx, error) => errors.push(error)
  };
  load("daemon/plugins/file/src/backend/file_router.ts", {
    "./runtime": { ...runtime, protocol: () => protocol },
    "./file_service": { getFileManager: () => manager },
    "./upload_manager": {},
    "./url": {}
  }).registerFileEvents();
  for (const event of ["file/create-text", "file/remove-file"]) {
    pending = new Promise((resolve) => {
      finish = resolve;
    });
    const count = responses.length;
    const operation = handlers.get(event)(
      {},
      { instanceUuid: "owned", target: "file.txt", text: "text" }
    );
    await Promise.resolve();
    assert.equal(responses.length, count);
    finish(true);
    await operation;
    assert.equal(responses.length, count + 1);
    assert.equal(responses.at(-1), true);
    pending = Promise.reject(new Error("Disk failed"));
    await handlers.get(event)({}, { instanceUuid: "owned", target: "file.txt", text: "text" });
    assert.equal(responses.length, count + 1);
    assert.match(errors.at(-1).message, /Disk failed/);
  }
});
