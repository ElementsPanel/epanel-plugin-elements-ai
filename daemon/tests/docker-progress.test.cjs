const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../../../..");
const requireDaemon = Module.createRequire(path.join(root, "daemon/package.json"));
const ts = requireDaemon("typescript");
const serviceDir = path.join(root, "daemon/plugins/instance/src/backend/service");
function load(filename, overrides = {}) {
  const mod = new Module(filename, module);
  mod.require = (id) => Object.hasOwn(overrides, id) ? overrides[id] : requireDaemon(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename);
  return mod.exports;
}
const trackerModule = load(path.join(serviceDir, "docker_build_progress.ts"));
const { DockerBuildTracker } = trackerModule;

test("Docker progress aggregates download layers without counting extraction twice", () => {
  const tracker = new DockerBuildTracker();
  assert.equal(tracker.snapshot().percentage, undefined);
  tracker.update({ id: "a", status: "Downloading", progressDetail: { current: 25, total: 100 } });
  tracker.update({ id: "b", status: "Downloading", progressDetail: { current: 50, total: 200 } });
  assert.equal(tracker.snapshot().percentage, 25);
  tracker.update({ id: "a", status: "Extracting", progressDetail: { current: 800, total: 1000 } });
  assert.equal(tracker.snapshot().downloadedBytes, 150);
  assert.equal(tracker.snapshot().totalBytes, 300);
  assert.equal(tracker.snapshot().percentage, 50);
  tracker.update({ id: "b", status: "Download complete" });
  assert.equal(tracker.snapshot().percentage, 99);
  tracker.finish();
  assert.equal(tracker.snapshot().percentage, 100);
});

test("Docker progress handles unknown sizes, cached layers and failures", () => {
  const tracker = new DockerBuildTracker();
  tracker.update({ id: "a", status: "Pulling fs layer" });
  tracker.update({ id: "b", status: "Downloading", progressDetail: { current: 50, total: 100 } });
  assert.equal(tracker.snapshot().percentage, undefined);
  tracker.update({ id: "a", status: "Already exists" });
  assert.equal(tracker.snapshot().percentage, 50);
  tracker.update({ id: "b", status: "Downloading", progressDetail: { current: NaN, total: Infinity } });
  assert.equal(tracker.snapshot().percentage, 50);
  tracker.finish(new Error("registry denied"));
  assert.equal(tracker.snapshot().status, -1);
  assert.equal(tracker.snapshot().error, "registry denied");
  assert.notEqual(tracker.snapshot().percentage, 100);
});

const { DockerManager } = load(path.join(serviceDir, "docker_service.ts"), {
  "./docker_build_progress": trackerModule,
  "mcsmanager-common": { normalizeDockerPlatform: () => "linux/amd64" }
});

test("Docker build streams publish intermediate progress and propagate failures", async () => {
  const manager = new DockerManager();
  const snapshots = [];
  manager.docker = {
    buildImage: async () => Readable.from([]),
    modem: { followProgress(_stream, done, progress) {
      progress({ id: "layer", status: "Downloading", progressDetail: { current: 30, total: 100 } });
      snapshots.push(DockerManager.builderDetails.get("test:ok"));
      done(null, []);
    } }
  };
  await manager.startBuildImage("/unused", "test:ok");
  assert.equal(snapshots[0].percentage, 30);
  assert.equal(DockerManager.builderDetails.get("test:ok").percentage, 100);
  assert.equal(DockerManager.builderProgress.get("test:ok"), 2);
  manager.docker.modem.followProgress = (_stream, done) => done(new Error("failed build"));
  await assert.rejects(manager.startBuildImage("/unused", "test:fail"), /failed build/);
  assert.equal(DockerManager.builderProgress.get("test:fail"), -1);
  assert.equal(DockerManager.builderDetails.get("test:fail").error, "failed build");
});

test("Docker progress endpoint preserves legacy response and exposes opt-in details", async () => {
  const handlers = new Map();
  let response;
  load(path.join(serviceDir, "../routers/environment_router.ts"), {
    "../i18n": { $t: (key) => key },
    "../service/docker_service": { DockerManager },
    "../service/log": { info() {} },
    "../service/protocol": { response(_ctx, value) { response = value; }, responseError(_ctx, error) { throw error; } },
    "../service/router": { routerApp: { on(event, callback) { handlers.set(event, callback); } } }
  });
  DockerManager.builderProgress.set("api:test", 1);
  DockerManager.builderDetails.set("api:test", { status: 1, percentage: 42, downloadedBytes: 42, totalBytes: 100 });
  await handlers.get("environment/progress")({}, {});
  assert.equal(response["api:test"], 1);
  await handlers.get("environment/progress")({}, { details: true });
  assert.equal(response["api:test"].percentage, 42);
});
