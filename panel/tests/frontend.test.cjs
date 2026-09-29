const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../../../..");
const frontendRequire = Module.createRequire(path.join(root, "frontend/package.json"));
const { JSDOM } = frontendRequire("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://panel.example/prefix/"
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "SVGElement",
  "Event",
  "KeyboardEvent"
])
  global[key] = dom.window[key];
dom.window.HTMLElement.prototype.scrollTo = function () {};
const frames = new Map();
let frameId = 0;
dom.window.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
dom.window.cancelAnimationFrame = (id) => frames.delete(id);
function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}
const vue = frontendRequire("vue");
const { mount, flushPromises } = frontendRequire("@vue/test-utils");
const { parse, compileScript } = frontendRequire("@vue/compiler-sfc");
const ts = frontendRequire("typescript");

function load(relative, overrides, source) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.require = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.startsWith(".")) {
      const base = path.resolve(path.dirname(filename), id);
      if (base.endsWith(".vue")) {
        const descriptor = parse(fs.readFileSync(base, "utf8"), { filename: base }).descriptor;
        const script = compileScript(descriptor, { id: base, inlineTemplate: true });
        return load(path.relative(root, base), overrides, script.content);
      }
      if (fs.existsSync(base + ".ts")) return load(path.relative(root, base + ".ts"), overrides);
    }
    return frontendRequire(id);
  };
  mod._compile(
    ts.transpileModule(source ?? fs.readFileSync(filename, "utf8"), {
      fileName: filename + ".ts",
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

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function sidebar(api = {}) {
  const state = vue.reactive({ open: false });
  const route = vue.reactive({ path: "/instances" });
  const navigations = [];
  const calls = [];
  const translations = [];
  const { h, defineComponent } = vue;
  const block = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", [slots.prepend?.(), slots.append?.(), slots.default?.()])
  });
  const components = {
    VCard: block,
    VCardActions: block,
    VCardText: block,
    VDivider: block,
    VForm: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("form", slots.default?.())
    }),
    VTextField: defineComponent({
      props: ["modelValue", "disabled", "label", "type"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          h("input", {
            "data-label": props.label,
            value: props.modelValue,
            type: props.type || "text",
            disabled: props.disabled,
            onInput: (event) => emit("update:modelValue", event.target.value)
          })
    }),
    VCheckbox: defineComponent({
      props: ["modelValue", "label"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          h("input", {
            type: "checkbox",
            "data-label": props.label,
            checked: props.modelValue,
            onChange: (event) => emit("update:modelValue", event.target.checked)
          })
    }),
    VSelect: defineComponent({
      props: ["modelValue", "items", "disabled", "label", "itemTitle", "itemValue"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          h(
            "select",
            {
              disabled: props.disabled,
              "data-label": props.label,
              value: props.modelValue ?? "",
              onChange: (event) =>
                emit(
                  "update:modelValue",
                  props.items[event.target.selectedIndex]?.[props.itemValue || "value"]
                )
            },
            props.items?.map((item) =>
              h(
                "option",
                { value: String(item[props.itemValue || "value"] ?? "") },
                item[props.itemTitle || "title"]
              )
            )
          )
    }),
    VDialog: defineComponent({
      props: ["modelValue"],
      setup:
        (props, { slots }) =>
        () =>
          props.modelValue ? h("div", slots.default?.()) : null
    }),
    VBtn: defineComponent({
      props: ["disabled", "type"],
      setup:
        (props, { slots }) =>
        () =>
          h("button", { disabled: props.disabled, type: props.type || "button" }, slots.default?.())
    }),
    VTooltip: defineComponent({
      props: ["text", "location"],
      setup:
        (_, { slots }) =>
        () =>
          slots.activator?.({ props: {} })
    }),
    VTextarea: defineComponent({
      props: ["modelValue", "disabled"],
      emits: ["update:modelValue"],
      setup: (props, { emit, expose }) => {
        expose({ focus() {} });
        return () =>
          h("textarea", {
            value: props.modelValue,
            disabled: props.disabled,
            onInput: (event) => emit("update:modelValue", event.target.value)
          });
      }
    }),
    VAlert: defineComponent({ props: ["text"], setup: (props) => () => h("div", props.text) }),
    VIcon: block,
    VDivider: block,
    VProgressLinear: block,
    VProgressCircular: defineComponent({
      props: ["size", "width", "indeterminate"],
      setup: (props) => () => h("span", { role: "progressbar", "data-size": props.size })
    })
  };
  const filename = "external/epanel-plugin-elements-ai/panel/src/AiSidebar.vue";
  const descriptor = parse(fs.readFileSync(path.join(root, filename), "utf8"), {
    filename
  }).descriptor;
  const component = compileScript(descriptor, { id: "ai-test", inlineTemplate: true });
  class AccountChangedError extends Error {}
  const entry = load(
    filename,
    {
      "vue-router": {
        useRoute: () => route,
        useRouter: () => ({ push: (value) => navigations.push(value) })
      },
      "vue-i18n": { useI18n: () => ({ t: (key) => { translations.push(key); return key; }, locale: vue.ref("en-US") }) },
      "vuetify/components": components,
      "./api": {
        AccountChangedError,
        updateChatSettings: async () => true,
        enqueueChatMessage: async () => true,
        listConversations: async () => [],
        deleteConversations: async () => 0,
        getStatus: async () => ({
          ready: true,
          admin: true,
          userId: "alice",
          models: [{ id: "preset:default", name: "Default", model: "test", source: "preset" }]
        }),
        sendMessage: async (...args) => {
          calls.push(args);
          const onEvent = args[5];
          onEvent({
            type: "start",
            conversationId: "a".repeat(32),
            messages: [{ role: "user", content: args[0] }]
          });
          onEvent({ type: "message", index: 1, message: { role: "assistant", content: "" } });
          onEvent({ type: "delta", index: 1, content: "<img src=x onerror=alert(1)>" });
          onEvent({ type: "done", conversationId: "a".repeat(32) });
        },
        ...api
      }
    },
    component.content
  ).default;
  return {
    wrapper: mount(entry, { props: { state } }),
    state,
    route,
    navigations,
    calls,
    translations,
    components,
    AccountChangedError
  };
}

test("header button toggles the shared sidebar state", async () => {
  const filename = "external/epanel-plugin-elements-ai/panel/src/AiButton.vue";
  const descriptor = parse(fs.readFileSync(path.join(root, filename), "utf8"), {
    filename
  }).descriptor;
  const script = compileScript(descriptor, { id: "epanel-plugin-elements-ai-button", inlineTemplate: true });
  const state = vue.reactive({ open: false });
  const component = load(
    filename,
    {
      "vue-i18n": { useI18n: () => ({ t: (key) => key }) },
      "vuetify/components": {
        VBtn: vue.defineComponent({ setup: () => () => vue.h("button") }),
        VTooltip: vue.defineComponent({
          props: ["text", "location"],
          setup:
            (_, { slots }) =>
            () =>
              slots.activator?.({ props: {} })
        })
      }
    },
    script.content
  ).default;
  const wrapper = mount(component, { props: { state } });
  await wrapper.get("button").trigger("click");
  assert.equal(state.open, true);
  assert.equal(wrapper.get("button").attributes("aria-expanded"), "true");
  await wrapper.get("button").trigger("click");
  assert.equal(state.open, false);
  wrapper.unmount();
});

test("sidebar respects IME/Shift+Enter and displays model text without HTML execution", async () => {
  const f = sidebar();
  f.state.open = true;
  await flushPromises();
  const input = f.wrapper.get("textarea");
  await input.setValue("List my instances");
  await input.trigger("keydown", { key: "Enter", shiftKey: true });
  await input.trigger("keydown", { key: "Enter", isComposing: true });
  assert.equal(f.calls.length, 0);
  await input.trigger("keydown", { key: "Enter" });
  await flushPromises();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "List my instances");
  assert.equal(f.calls[0][2], "preset:default");
  assert.equal(f.calls[0][3], "alice");
  assert.equal(f.wrapper.find(".ai-input-box .ai-character-count").exists(), false);
  assert.ok(f.wrapper.text().includes("<img src=x onerror=alert(1)>"));
  assert.equal(f.wrapper.findAll("img").length, 0);
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(
    f.wrapper.findAll(".ai-settings-actions button").map((button) => button.text()),
    ["AI_SAVE_SETTINGS", "AI_SETTINGS"]
  );
  assert.equal(f.wrapper.get('[aria-label="AI_SETTINGS"]').attributes("type"), "button");
  await f.wrapper.get('[aria-label="AI_SETTINGS"]').trigger("click");
  assert.deepEqual(f.navigations, [
    { path: "/plugins/config", query: { scope: "panel", plugin: "epanel-plugin-elements-ai" } }
  ]);
  f.wrapper.unmount();
});

test("character count stays inside the rounded input box", async () => {
  const f = sidebar();
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("hello");
  await vue.nextTick();
  assert.equal(f.wrapper.get(".ai-input-box .ai-character-count").text(), "5 / 4000");
  assert.equal(f.wrapper.findAll(".ai-composer > .ai-character-count").length, 0);
  f.wrapper.unmount();
});

test("permission selector precedes models, defaults safely and resets on logout", async (t) => {
  const f = sidebar();
  t.after(() => f.wrapper.unmount());
  f.state.open = true;
  await flushPromises();
  assert.equal(f.wrapper.find(".ai-scope").exists(), false);
  assert.doesNotMatch(f.wrapper.text(), /AI_ADMIN_SCOPE|AI_USER_SCOPE/);
  assert.deepEqual(
    f.wrapper.findAll(".ai-model-picker select").map((item) => item.attributes("aria-label")),
    ["AI_PERMISSION_MODE", "AI_SELECT_MODEL"]
  );
  const selector = () => f.wrapper.get('[aria-label="AI_PERMISSION_MODE"]');
  assert.equal(selector().element.value, "default");
  await f.wrapper.get("textarea").setValue("Query my instance");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(f.calls[0][7], "default");
  await selector().setValue("full");
  await f.wrapper.get("textarea").setValue("Make changes");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(f.calls[1][7], "full");
  f.route.path = "/login";
  await vue.nextTick();
  f.route.path = "/instances";
  f.state.open = true;
  await flushPromises();
  assert.equal(selector().element.value, "default");
});

test("chat approvals show exact arguments, submit the user's decision and disappear after settlement", async (t) => {
  for (const approved of [true, false]) {
    const pending = deferred();
    const decision = deferred();
    const decisions = [];
    let emit;
    let signal;
    const approval = {
      id: "a".repeat(32),
      arguments: JSON.stringify(
        { daemonId: "node", instanceUuid: "owned", path: "<img src=x>.txt" },
        null,
        2
      )
    };
    const message = { role: "tool", tool: "delete_file", content: "", pending: true, approval };
    const f = sidebar({
      sendMessage: async (_m, _c, _model, _user, value, onEvent) => {
        emit = onEvent;
        signal = value;
        emit({ type: "message", index: 1, message });
        await pending.promise;
      },
      respondToApproval: async (...args) => {
        decisions.push(args);
        await decision.promise;
      }
    });
    t.after(() => {
      decision.resolve();
      pending.resolve();
      f.wrapper.unmount();
    });
    f.state.open = true;
    await flushPromises();
    await f.wrapper.get("textarea").setValue("Delete file");
    await f.wrapper.get("form").trigger("submit");
    assert.equal(f.wrapper.get('[aria-label="AI_PERMISSION_MODE"]').element.disabled, false);
    assert.match(f.wrapper.get('[role="status"]').text(), /AI_WAITING_APPROVAL/);
    assert.equal(f.wrapper.get(".ai-approval pre").text(), approval.arguments);
    assert.equal(f.wrapper.findAll("img").length, 0);
    const button = f.wrapper
      .findAll(".ai-approval button")
      .find((item) => item.text() === (approved ? "AI_APPROVE_ONCE" : "AI_DENY"));
    await button.trigger("click");
    assert.deepEqual(decisions[0].slice(0, 3), [approval.id, approved, "alice"]);
    assert.equal(decisions[0][3], signal);
    assert.equal(
      f.wrapper.findAll(".ai-approval button").every((item) => item.element.disabled),
      true
    );
    emit({
      type: "message",
      index: 1,
      message: {
        role: "tool",
        tool: "delete_file",
        pending: false,
        ok: approved,
        content: approved ? "Deleted" : "Denied"
      }
    });
    decision.resolve();
    await flushPromises();
    assert.equal(f.wrapper.find(".ai-approval").exists(), false);
    pending.resolve();
    await flushPromises();
    assert.equal(
      signal.aborted,
      true,
      "finishing a task also cancels leftover approval submissions"
    );
    assert.equal(f.wrapper.get('[aria-label="AI_PERMISSION_MODE"]').element.disabled, false);
  }
});

test("chat questions block for an option or custom answer and disappear after settlement", async (t) => {
  for (const custom of [false, true]) {
    const pending = deferred();
    const response = deferred();
    const answers = [];
    let emit;
    let signal;
    const question = {
      id: custom ? "custom-question" : "option-question",
      question: "Which Java should be used?",
      options: ["Java 17", "Java 21"]
    };
    const f = sidebar({
      sendMessage: async (_m, _c, _model, _user, value, onEvent) => {
        emit = onEvent;
        signal = value;
        emit({
          type: "message",
          index: 1,
          message: { role: "tool", tool: "ask_user", content: "", pending: true, question }
        });
        await pending.promise;
      },
      respondToQuestion: async (...args) => {
        answers.push(args);
        await response.promise;
      }
    });
    t.after(() => {
      response.resolve();
      pending.resolve();
      f.wrapper.unmount();
    });
    f.state.open = true;
    await flushPromises();
    await f.wrapper.get("textarea").setValue("Prepare Java");
    await f.wrapper.get("form").trigger("submit");
    assert.match(f.wrapper.get('[role="status"]').text(), /AI_WAITING_ANSWER/);
    assert.equal(f.wrapper.get(".ai-question p").text(), question.question);
    assert.deepEqual(
      f.wrapper.findAll(".ai-question-options button").map((button) => button.text()),
      question.options
    );
    const expected = custom ? "Use the system Java" : "Java 21";
    if (custom) {
      await f.wrapper.get(".ai-question textarea").setValue(expected);
      await f.wrapper
        .findAll(".ai-question button")
        .find((button) => button.text() === "AI_SUBMIT_ANSWER")
        .trigger("click");
    } else {
      await f.wrapper
        .findAll(".ai-question-options button")
        .find((button) => button.text() === expected)
        .trigger("click");
    }
    assert.deepEqual(answers[0].slice(0, 3), [question.id, expected, "alice"]);
    assert.equal(answers[0][3], signal);
    assert.equal(
      f.wrapper.findAll(".ai-question button").every((item) => item.element.disabled),
      true
    );
    assert.equal(f.wrapper.get(".ai-question textarea").element.disabled, true);
    emit({
      type: "message",
      index: 1,
      message: {
        role: "tool",
        tool: "ask_user",
        pending: false,
        ok: true,
        content: JSON.stringify({ answer: expected })
      }
    });
    response.resolve();
    await flushPromises();
    assert.equal(f.wrapper.find(".ai-question").exists(), false);
    pending.resolve();
    await flushPromises();
    assert.equal(signal.aborted, true);
  }
});

test("stopping while awaiting approval removes its controls without granting permission", async (t) => {
  const pending = deferred();
  let signal;
  let decisions = 0;
  const f = sidebar({
    sendMessage: async (_m, _c, _model, _user, value, emit) => {
      signal = value;
      signal.addEventListener("abort", () => pending.resolve(), { once: true });
      emit({
        type: "message",
        index: 1,
        message: {
          role: "tool",
          tool: "delete_file",
          pending: true,
          content: "",
          approval: { id: "id", arguments: "{}" }
        }
      });
      await pending.promise;
      throw new Error("Interrupted");
    },
    respondToApproval: async () => {
      decisions++;
    }
  });
  t.after(() => {
    pending.resolve();
    f.wrapper.unmount();
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Delete file");
  await f.wrapper.get("form").trigger("submit");
  assert.equal(f.wrapper.find(".ai-approval").exists(), true);
  await f.wrapper.get('[aria-label="AI_STOP_REPLY"]').trigger("click");
  await flushPromises();
  assert.equal(signal.aborted, true);
  assert.equal(decisions, 0);
  assert.equal(f.wrapper.find(".ai-approval").exists(), false);
});

test("chat sends the current terminal instance context and omits it on other pages", async () => {
  const f = sidebar();
  f.route.path = "/instances/terminal";
  f.route.query = { daemonId: "node-a", instanceId: "owned" };
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Read this terminal");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.deepEqual(f.calls[0][6], { daemonId: "node-a", instanceUuid: "owned" });
  f.route.path = "/instances";
  await f.wrapper.get("textarea").setValue("List my instances");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(f.calls[1][6], undefined);
  f.wrapper.unmount();
});

test("logout clears messages and cancels a pending request; late answers stay hidden", async () => {
  const pending = deferred();
  let signal;
  const f = sidebar({
    sendMessage: async (_message, _id, _model, _user, value) => {
      signal = value;
      return pending.promise;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("PRIVATE MESSAGE");
  await f.wrapper.get("form").trigger("submit");
  assert.equal(signal.aborted, false);
  f.route.path = "/login";
  await vue.nextTick();
  assert.equal(signal.aborted, true);
  assert.equal(f.state.open, false);
  pending.resolve({
    conversationId: "a".repeat(32),
    messages: [{ role: "assistant", content: "OLD ACCOUNT DATA" }]
  });
  await flushPromises();
  f.route.path = "/instances";
  f.state.open = true;
  await flushPromises();
  assert.doesNotMatch(f.wrapper.text(), /PRIVATE MESSAGE|OLD ACCOUNT DATA/);
  f.wrapper.unmount();
});

test("frontend uses the host session token and blocks requests after an account switch", async () => {
  let account = { uuid: "alice", token: "SESSION_TOKEN" };
  const requests = [];
  const oldFetch = global.fetch;
  global.fetch = async (...args) => {
    requests.push(args);
    return {
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"done","conversationId":"id"}\n\n')
          );
          controller.close();
        }
      })
    };
  };
  try {
    const { sendMessage, AccountChangedError } = load("external/epanel-plugin-elements-ai/panel/src/api.ts", {
      "@elements-panel/sdk": {
        ctx: {
          get: () => ({
            api: { userInfoApi: () => ({ execute: async () => ({ value: account }) }) }
          })
        }
      }
    });
    const signal = new AbortController().signal;
    await sendMessage("hello", undefined, "preset:default", "alice", signal, () => {});
    assert.equal(requests[0][0], "./api/ai/chat");
    assert.equal(requests[0][1].headers.Authorization, "Bearer SESSION_TOKEN");
    assert.equal(requests[0][1].credentials, "same-origin");
    assert.deepEqual(JSON.parse(requests[0][1].body), {
      message: "hello",
      modelId: "preset:default",
      permissionMode: "default"
    });
    account = { uuid: "bob", token: "OTHER_TOKEN" };
    await assert.rejects(
      sendMessage("private", undefined, "preset:default", "alice", signal, () => {}),
      AccountChangedError
    );
    assert.equal(requests.length, 1);
  } finally {
    global.fetch = oldFetch;
  }
});

test("interactive response APIs send only their answer and refuse submissions after account changes", async (t) => {
  let account = { uuid: "alice", token: "SESSION_TOKEN" };
  const requests = [];
  const oldFetch = global.fetch;
  t.after(() => {
    global.fetch = oldFetch;
  });
  global.fetch = async (...args) => {
    requests.push(args);
    return { ok: true, json: async () => ({ status: 200, data: true }) };
  };
  const { respondToApproval, respondToQuestion, AccountChangedError } = load(
    "external/epanel-plugin-elements-ai/panel/src/api.ts",
    {
      "@elements-panel/sdk": {
        ctx: {
          get: () => ({
            api: { userInfoApi: () => ({ execute: async () => ({ value: account }) }) }
          })
        }
      }
    }
  );
  const signal = new AbortController().signal;
  assert.equal(await respondToApproval("approval-id", false, "alice", signal), true);
  assert.equal(requests[0][0], "./api/ai/approvals/approval-id");
  assert.equal(requests[0][1].method, "POST");
  assert.equal(requests[0][1].headers.Authorization, "Bearer SESSION_TOKEN");
  assert.deepEqual(JSON.parse(requests[0][1].body), { approved: false });
  assert.equal(requests[0][1].signal, signal);
  assert.equal(await respondToQuestion("question-id", "Custom answer", "alice", signal), true);
  assert.equal(requests[1][0], "./api/ai/questions/question-id");
  assert.equal(requests[1][1].method, "POST");
  assert.deepEqual(JSON.parse(requests[1][1].body), { answer: "Custom answer" });
  assert.equal(requests[1][1].signal, signal);
  account = { uuid: "bob", token: "OTHER_TOKEN" };
  await assert.rejects(
    respondToApproval("approval-id", true, "alice", signal),
    AccountChangedError
  );
  assert.equal(requests.length, 2);
});

test("sidebar renders deltas while generation is pending and preserves partial text after interruption", async () => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
      throw new Error("Disconnected");
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Hello");
  await f.wrapper.get("form").trigger("submit");
  emit({ type: "start", conversationId: "id", messages: [{ role: "user", content: "Hello" }] });
  emit({ type: "message", index: 1, message: { role: "assistant", content: "" } });
  emit({ type: "delta", index: 1, content: "First fragment" });
  await vue.nextTick();
  assert.match(f.wrapper.text(), /First fragment/);
  assert.equal(f.wrapper.get("textarea").element.disabled, false);
  emit({ type: "delta", index: 1, content: " and second" });
  await vue.nextTick();
  assert.match(f.wrapper.text(), /First fragment and second/);
  pending.resolve();
  await flushPromises();
  assert.match(f.wrapper.text(), /First fragment and second/);
  assert.match(f.wrapper.text(), /Disconnected/);
  f.wrapper.unmount();
});

test("sidebar keeps completed reasoning and work status beneath the assistant message", async (t) => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  t.after(() => {
    pending.resolve();
    f.wrapper.unmount();
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Check Java");
  await f.wrapper.get("form").trigger("submit");
  emit({ type: "start", conversationId: "id", messages: [{ role: "user", content: "Check Java" }] });
  emit({
    type: "message",
    index: 1,
    message: { role: "assistant", content: "", reasoning: "先检查节点\n" }
  });
  emit({
    type: "message",
    index: 1,
    message: { role: "assistant", content: "", reasoning: "先检查节点\n再确认 Java 版本" }
  });
  await vue.nextTick();
  assert.equal(f.wrapper.get(".ai-thinking-label").text(), "AI_THINKING_PREFIX");
  assert.equal(f.wrapper.get(".ai-thinking-content").text(), "先检查节点 再确认 Java 版本");
  assert.equal(f.wrapper.findAll(".ai-thinking-content").length, 1);
  emit({
    type: "message",
    index: 1,
    message: {
      role: "assistant",
      content: "",
      reasoning: "先检查节点\n再确认 Java 版本",
      reasoningComplete: true
    }
  });
  emit({ type: "delta", index: 1, content: "Java 21 is available." });
  await vue.nextTick();
  assert.equal(f.wrapper.get(".ai-thinking-label").text(), "AI_THINKING_COMPLETE_PREFIX");
  assert.equal(f.wrapper.get(".ai-thinking-content").text(), "先检查节点 再确认 Java 版本");
  emit({
    type: "message",
    index: 1,
    message: {
      role: "assistant",
      content: "Java 21 is available.",
      reasoning: "先检查节点\n再确认 Java 版本",
      reasoningComplete: true,
      workComplete: true
    }
  });
  emit({ type: "done", conversationId: "id" });
  await vue.nextTick();
  assert.equal(f.wrapper.get(".ai-work-complete").text(), "AI_WORK_COMPLETE");
  pending.resolve();
  await flushPromises();
  assert.equal(f.wrapper.get(".ai-thinking-label").text(), "AI_THINKING_COMPLETE_PREFIX");
  assert.equal(f.wrapper.get(".ai-work-complete").text(), "AI_WORK_COMPLETE");
});

test("reconnection replaces partial messages, shows its status and can be stopped immediately", async (t) => {
  const pending = deferred();
  let emit;
  let signal;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, value, onEvent) => {
      signal = value;
      emit = onEvent;
      signal.addEventListener("abort", () => pending.resolve(), { once: true });
      await pending.promise;
      throw new Error("Interrupted");
    }
  });
  t.after(() => {
    pending.resolve();
    f.wrapper.unmount();
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Install mods");
  await f.wrapper.get("form").trigger("submit");
  const completed = [
    { role: "user", content: "Install mods" },
    { role: "tool", tool: "download_mod", pending: false, ok: true, content: "COMPLETED_DOWNLOAD" }
  ];
  emit({ type: "start", conversationId: "id", messages: structuredClone(completed) });
  emit({ type: "message", index: 2, message: { role: "assistant", content: "DISCARD_PARTIAL" } });
  emit({
    type: "message",
    index: 3,
    message: { role: "tool", tool: "download_mod", pending: true, content: "" }
  });
  await vue.nextTick();
  assert.match(f.wrapper.text(), /DISCARD_PARTIAL/);
  assert.equal(f.wrapper.findAll('[role="progressbar"]').length, 1);
  emit({ type: "start", conversationId: "id", messages: structuredClone(completed) });
  emit({ type: "retry", attempt: 1, maxAttempts: 5, delayMs: 1000 });
  await vue.nextTick();
  assert.match(f.wrapper.get('[role="status"]').text(), /AI_RETRYING/);
  assert.doesNotMatch(f.wrapper.text(), /DISCARD_PARTIAL/);
  assert.match(f.wrapper.text(), /COMPLETED_DOWNLOAD/);
  assert.equal(f.wrapper.findAll('[role="progressbar"]').length, 0);
  emit({ type: "message", index: 2, message: { role: "assistant", content: "Recovered" } });
  await vue.nextTick();
  assert.match(f.wrapper.get('[role="status"]').text(), /AI_WORKING/);
  assert.doesNotMatch(f.wrapper.text(), /AI_RETRYING/);
  emit({ type: "retry", attempt: 2, maxAttempts: 5, delayMs: 2000 });
  await vue.nextTick();
  await f.wrapper.get('[aria-label="AI_STOP_REPLY"]').trigger("click");
  assert.equal(signal.aborted, true);
  await flushPromises();
  assert.equal(f.wrapper.find('[role="status"]').exists(), false);
  assert.equal(f.wrapper.get("textarea").element.disabled, false);
  assert.match(f.wrapper.text(), /COMPLETED_DOWNLOAD/);
  assert.equal(f.wrapper.get('[aria-label="AI_SEND"]').attributes("size"), "x-small");
});

test("tool rows replace same-size spinners with distinct icons and mark only failed names red", async () => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Manage my instances");
  await f.wrapper.get("form").trigger("submit");
  const tools = [
    "list_nodes",
    "list_instances",
    "get_instance",
    "control_instance",
    "update_instance",
    "create_instance",
    "read_terminal",
    "list_mod_game_versions",
    "search_mods",
    "list_mod_versions",
    "list_installed_mods",
    "download_mod",
    "download_mod_batch",
    "get_mod_download_status",
    "list_msl_servers",
    "list_msl_versions",
    "list_msl_builds",
    "get_msl_download",
    "download_msl_server",
    "get_msl_download_status",
    "create_msl_instance",
    "get_msl_install_status",
    "list_files",
    "read_file",
    "edit_file",
    "create_file",
    "delete_file"
  ];
  for (const [index, tool] of tools.entries())
    emit({
      type: "message",
      index: index + 1,
      message: { role: "tool", tool, pending: true, content: "" }
    });
  await vue.nextTick();
  const rows = f.wrapper.findAll(".ai-tool");
  assert.equal(rows.length, tools.length);
  const elements = rows.map((row) => row.element);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.get("summary").attributes("aria-busy"), "true");
    assert.equal(row.get('[role="progressbar"]').attributes("data-size"), "18");
    assert.equal(row.get(".ai-tool-name").text(), `AI_TOOL_${tools[index]}`);
    assert.equal(row.find("pre").exists(), false);
    assert.equal(row.find(".ai-tool-name--failed").exists(), false);
  }
  for (const [index, tool] of tools.entries())
    emit({
      type: "message",
      index: index + 1,
      message: {
        role: "tool",
        tool,
        pending: false,
        ok: index !== tools.length - 1,
        content: "Result"
      }
    });
  await vue.nextTick();
  const completed = f.wrapper.findAll(".ai-tool");
  assert.equal(completed.length, tools.length);
  assert.equal(f.wrapper.findAll('.ai-tool [role="progressbar"]').length, 0);
  const iconFont = fs.readFileSync(
    path.join(root, "frontend/node_modules/@mdi/font/css/materialdesignicons.css"),
    "utf8"
  );
  const icons = [];
  for (const [index, row] of completed.entries()) {
    assert.equal(row.element, elements[index]);
    assert.equal(row.get(".ai-tool-name").text(), `AI_TOOL_${tools[index]}`);
    assert.equal(row.get("summary").attributes("aria-busy"), undefined);
    const icon = row.get(".ai-tool-icon [icon]");
    assert.equal(icon.attributes("size"), "18");
    icons.push(icon.attributes("icon"));
    assert.ok(iconFont.includes(`.${icons[index]}::before`));
    assert.equal(
      row.get(".ai-tool-name").classes().includes("ai-tool-name--failed"),
      index === tools.length - 1
    );
  }
  assert.equal(new Set(icons).size, tools.length);
  assert.doesNotMatch(f.wrapper.get(".ai-messages").text(), /AI_SUCCESS|AI_FAILED|AI_TOOL_RUNNING/);
  emit({ type: "done", conversationId: "id" });
  pending.resolve();
  await flushPromises();
  f.wrapper.unmount();
});

for (const tool of ["edit_file", "create_file"])
test(`successful ${tool} shows an escaped inline diff below the tool without opening its receipt`, async () => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Edit the file");
  await f.wrapper.get("form").trigger("submit");
  const message = { role: "tool", tool, pending: true, content: "" };
  emit({ type: "message", index: 1, message: { ...message } });
  await vue.nextTick();
  assert.equal(f.wrapper.find(".ai-file-diff").exists(), false);
  const diff = {
    path: "config/<img src=x>.txt",
    patch: "@@ -1,1 +1,1 @@\n-old\r\n+<img src=x onerror=alert(1)>",
    truncated: false
  };
  emit({
    type: "message",
    index: 1,
    message: { ...message, pending: false, ok: true, content: "{}", diff }
  });
  await vue.nextTick();
  const row = f.wrapper.get(".ai-message--tool");
  assert.equal(row.get("details").attributes("open"), undefined);
  assert.equal(row.find("details .ai-file-diff").exists(), false);
  assert.equal(row.get(".ai-file-diff figcaption").text(), diff.path);
  assert.equal(row.get(".ai-diff-line--removed").text(), "-old␍");
  assert.equal(row.get(".ai-diff-line--added").text(), "+<img src=x onerror=alert(1)>");
  assert.equal(row.findAll("img").length, 0);
  emit({
    type: "message",
    index: 2,
    message: { ...message, pending: false, ok: false, content: "Rejected", diff }
  });
  await vue.nextTick();
  assert.equal(f.wrapper.findAll(".ai-file-diff").length, 1);
  emit({
    type: "message",
    index: 1,
    message: {
      ...message,
      pending: false,
      ok: true,
      content: "{}",
      diff: { ...diff, truncated: true }
    }
  });
  await vue.nextTick();
  assert.match(row.get(".ai-file-diff").text(), /AI_DIFF_TRUNCATED/);
  emit({
    type: "message",
    index: 1,
    message: { ...message, pending: false, ok: true, content: "{}", diff: { ...diff, patch: "" } }
  });
  await vue.nextTick();
  assert.match(row.get(".ai-file-diff").text(), /AI_DIFF_EMPTY/);
  pending.resolve();
  await flushPromises();
  f.wrapper.unmount();
});

test("disconnecting or stopping generation settles pending tool indicators", async () => {
  for (const cancelled of [false, true]) {
    const pending = deferred();
    const f = sidebar({
      sendMessage: async (_message, _conversation, _model, _user, signal, onEvent) => {
        signal.addEventListener("abort", () => pending.resolve(), { once: true });
        onEvent({
          type: "message",
          index: 1,
          message: { role: "tool", tool: "edit_file", pending: true, content: "" }
        });
        await pending.promise;
        throw new Error("Disconnected");
      }
    });
    f.state.open = true;
    await flushPromises();
    await f.wrapper.get("textarea").setValue("Edit my file");
    await f.wrapper.get("form").trigger("submit");
    assert.equal(f.wrapper.findAll('.ai-tool [role="progressbar"]').length, 1);
    if (cancelled) await f.wrapper.get('[aria-label="AI_STOP_REPLY"]').trigger("click");
    else pending.resolve();
    await flushPromises();
    assert.equal(f.wrapper.findAll('.ai-tool [role="progressbar"]').length, 0);
    assert.equal(f.wrapper.findAll(".ai-tool-name--failed").length, 1);
    assert.match(f.wrapper.get(".ai-tool pre").text(), /AI_CHECK_RESULT/);
    assert.equal(f.wrapper.get("textarea").element.disabled, false);
    if (cancelled) assert.match(f.wrapper.text(), /AI_INTERRUPTED/);
    f.wrapper.unmount();
  }
});

test("Markdown renders streamed text, code, lists and tables without executing embedded HTML", async () => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_m, _c, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("**Hello**");
  await f.wrapper.get("form").trigger("submit");
  assert.equal(f.wrapper.get(".ai-message--user strong").text(), "Hello");
  emit({ type: "message", index: 1, message: { role: "assistant", content: "" } });
  emit({ type: "delta", index: 1, content: "## Heading\n\n**Bold**\n\n- One\n- Two\n\n```js\n" });
  await vue.nextTick();
  assert.equal(f.wrapper.get(".ai-message--assistant h2").text(), "Heading");
  assert.equal(f.wrapper.findAll(".ai-message--assistant li").length, 2);
  emit({
    type: "delta",
    index: 1,
    content:
      "<script>alert(1)</script>\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com) [bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>"
  });
  await vue.nextTick();
  const message = f.wrapper.get(".ai-message--assistant");
  assert.equal(message.findAll("table").length, 1);
  assert.equal(message.get("pre code").text(), "<script>alert(1)</script>");
  assert.equal(message.findAll("script,img,[onerror]").length, 0);
  assert.equal(message.findAll('[href^="javascript:"]').length, 0);
  assert.equal(
    message.get('a[href="https://example.com"]').attributes("rel"),
    "noopener noreferrer"
  );
  pending.resolve();
  await flushPromises();
  f.wrapper.unmount();
});

test("personal settings only control sending and preserve the model selected in the composer", async () => {
  let preferences = {
    sendOnEnter: true
  };
  const writes = [];
  const models = [
    { id: "preset:default", name: "Default", source: "preset" },
    { id: "personal:mine", name: "Mine", source: "personal" }
  ];
  const f = sidebar({
    getStatus: async () => ({
      ready: true,
      admin: false,
      userId: "alice",
      models,
      preferences: { ...preferences }
    }),
    savePreferences: async (value, user) => {
      writes.push({ value, user });
      preferences = { ...value };
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').setValue("personal:mine");
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.equal(f.wrapper.find('[aria-label="AI_SETTINGS"]').exists(), false);
  assert.equal(f.wrapper.find(".ai-sidebar-settings select").exists(), false);
  assert.deepEqual(
    f.wrapper.findAll('input[type="checkbox"]').map((input) => input.attributes("data-label")),
    ["AI_SEND_ON_ENTER"]
  );
  await f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').setValue(false);
  await f.wrapper.get(".ai-sidebar-settings form").trigger("submit");
  await flushPromises();
  assert.equal(writes[0].user, "alice");
  assert.deepEqual(preferences, {
    sendOnEnter: false
  });
  assert.equal(f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').element.value, "personal:mine");
  let scrolls = 0;
  f.wrapper.get(".ai-messages").element.scrollTo = () => {
    scrolls++;
  };
  await f.wrapper.get("textarea").setValue("**Formatted text**");
  await f.wrapper.get("textarea").trigger("keydown", { key: "Enter" });
  assert.equal(f.calls.length, 0);
  await f.wrapper.get("textarea").trigger("keydown", { key: "Enter", ctrlKey: true });
  await flushPromises();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2], "personal:mine");
  assert.equal(f.wrapper.get(".ai-message--user strong").text(), "Formatted text");
  paint();
  assert.ok(scrolls > 0);
  const emit = f.calls[0][5];
  emit({
    type: "message",
    index: 2,
    message: {
      role: "tool",
      tool: "edit_file",
      ok: true,
      content: "{}",
      diff: { path: "f", patch: "-a\n+b", truncated: false }
    }
  });
  await vue.nextTick();
  assert.equal(f.wrapper.find(".ai-file-diff").exists(), true);
  await f.wrapper.get('[aria-label="AI_NEW_CHAT"]').trigger("click");
  assert.equal(f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').element.value, "personal:mine");
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.equal(f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').element.checked, false);
  f.wrapper.unmount();
});

test("streaming follows the conversation only while the user remains near the bottom", async (t) => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  t.after(() => {
    pending.resolve();
    f.wrapper.unmount();
  });
  f.state.open = true;
  await flushPromises();
  const messages = f.wrapper.get(".ai-messages");
  const element = messages.element;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 800 }
  });
  let scrolls = 0;
  element.scrollTo = ({ top }) => {
    scrolls++;
    element.scrollTop = top;
  };
  await f.wrapper.get("textarea").setValue("Stream a reply");
  await f.wrapper.get("form").trigger("submit");
  await vue.nextTick();
  paint();
  scrolls = 0;

  element.scrollTop = 200;
  await messages.trigger("scroll");
  emit({ type: "message", index: 1, message: { role: "assistant", content: "" } });
  emit({ type: "delta", index: 1, content: "First fragment" });
  await vue.nextTick();
  paint();
  assert.equal(scrolls, 0);

  element.scrollTop = 800;
  await messages.trigger("scroll");
  emit({ type: "delta", index: 1, content: " and second" });
  await vue.nextTick();
  paint();
  assert.ok(scrolls > 0);
});

test("multiple download tasks use a layered card stack while collapsed", async (t) => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  t.after(() => {
    pending.resolve();
    f.wrapper.unmount();
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Install several resources");
  await f.wrapper.get("form").trigger("submit");
  for (const [index, tool] of ["download_java", "download_mod", "create_msl_instance"].entries())
    emit({
      type: "download",
      action: "upsert",
      task: {
        id: `task-${index + 1}`,
        tool,
        state: "running",
        progress: { value: (index + 1) * 20 }
      }
    });
  await vue.nextTick();

  assert.equal(f.wrapper.find(".ai-downloads--multiple").exists(), true);
  const toggle = f.wrapper.get(".ai-download-toggle");
  assert.equal(toggle.attributes("aria-expanded"), "false");
  const cards = f.wrapper.findAll(".ai-download-stack-card");
  assert.equal(cards.length, 3);
  for (const [index, card] of cards.entries())
    assert.equal(card.classes().includes(`ai-download-stack-card--${index}`), true);
  assert.equal(f.wrapper.findAll(".ai-download-task").length, 0);

  await toggle.trigger("click");
  await vue.nextTick();
  assert.equal(f.wrapper.find(".ai-download-toggle").exists(), false);
  assert.equal(f.wrapper.findAll(".ai-download-stack-card").length, 0);
  assert.equal(f.wrapper.findAll(".ai-download-task").length, 3);

  await f.wrapper.get(".ai-downloads--multiple").trigger("mouseleave");
  await vue.nextTick();
  assert.equal(f.wrapper.get(".ai-download-toggle").attributes("aria-expanded"), "false");
  assert.equal(f.wrapper.findAll(".ai-download-stack-card").length, 3);
});

test("leaving an account cancels preference saves and ignores their late completion", async () => {
  const pending = deferred();
  let signal;
  const f = sidebar({
    savePreferences: async (_value, _user, value) => {
      signal = value;
      await pending.promise;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  await f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').setValue(false);
  await f.wrapper.get(".ai-sidebar-settings form").trigger("submit");
  f.route.path = "/login";
  await vue.nextTick();
  assert.equal(signal.aborted, true);
  pending.resolve();
  await flushPromises();
  f.route.path = "/instances";
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.equal(f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').element.checked, true);
  f.wrapper.unmount();
});

test("preset model dialogs commit only confirmed drafts and preserve hidden keys on save", async () => {
  const f = sidebar();
  const components = f.components;
  f.wrapper.unmount();
  // Retain dialog content during a simulated leave transition, just like Vuetify.
  components.VDialog = vue.defineComponent({
    props: ["modelValue"],
    emits: ["update:modelValue", "afterLeave"],
    setup:
      (_props, { slots }) =>
      () =>
        vue.h("div", slots.default?.())
  });
  let declaration;
  const saved = [];
  const { registerSettings } = load("external/epanel-plugin-elements-ai/panel/src/backend/settings.ts", {});
  const models = await registerSettings({
    i18n: { $t: (key) => key },
    settingsForm: {
      declare: (value) => {
        declaration = value;
      }
    },
    storage: {
      getStorage: () => ({
        load: async () => ({
          presets: [
            {
              id: "shared",
              name: "Shared",
              model: "m",
              endpoint: "https://example.com",
              apiKey: "KEEP_SECRET"
            }
          ]
        }),
        store: async (_category, _id, value) => saved.push(value)
      })
    }
  });
  const filename = "panel/plugins/config/src/SchemaForm.vue";
  const descriptor = parse(fs.readFileSync(path.join(root, filename), "utf8"), {
    filename
  }).descriptor;
  const script = compileScript(descriptor, { id: "schema-test", inlineTemplate: true });
  const entry = load(
    filename,
    {
      "@/lang/i18n": { t: (key) => key },
      "@/plugin/context": { usePluginService: () => undefined },
      "@/config/router": { router: { push() {} } },
      "vuetify/components": components
    },
    script.content
  ).default;
  const values = vue.reactive(declaration.read());
  const wrapper = mount(entry, {
    props: { fields: declaration.fields(), values, onSave: () => declaration.write(values) }
  });
  assert.equal(wrapper.findAll("textarea").length, 0);
  assert.equal(wrapper.findAll("form").length, 1);
  assert.equal(wrapper.findAll("input").length, 0);
  assert.equal(wrapper.findAll("select")[0].element.value, "true");
  assert.equal(wrapper.get(".setting-list-name").text(), "Shared");
  assert.equal(wrapper.findAll('.setting-list-actions [aria-label="AI_EDIT_MODEL"]').length, 1);
  assert.equal(wrapper.findAll('.setting-list-actions [aria-label="AI_DELETE_MODEL"]').length, 1);
  const dialog = () => wrapper.get(".setting-list-editor");
  const dialogButton = (text) =>
    dialog()
      .findAll("button")
      .find((button) => button.text() === text);
  const addButton = () =>
    wrapper.findAll("button").find((button) => button.text() === "AI_ADD_MODEL");
  const finishClose = async () => {
    const modal = wrapper.findComponent(components.VDialog);
    assert.equal(modal.props("modelValue"), false);
    assert.equal(wrapper.find(".setting-list-editor").exists(), true);
    const count = values.presets.length;
    await dialog().get("form").trigger("submit");
    assert.equal(values.presets.length, count);
    modal.vm.$emit("afterLeave");
    await vue.nextTick();
    assert.equal(wrapper.find(".setting-list-editor").exists(), false);
  };

  await wrapper.get('[aria-label="AI_EDIT_MODEL"]').trigger("click");
  assert.equal(dialog().attributes("title"), "TXT_CODE_ad207008");
  assert.equal(dialog().get('input[type="password"]').element.value, "");
  await dialog().findAll("input")[0].setValue("Cancelled edit");
  await dialog().get('input[type="password"]').setValue("DISCARD_SECRET");
  await dialog().get("select").setValue("true");
  await dialog().findAll("select")[1].setValue("low");
  assert.equal(values.presets[0].name, "Shared");
  assert.equal(values.presets[0].apiKey, "");
  assert.equal(values.presets[0].thinkingEnabled, "");
  await dialogButton("TXT_CODE_a0451c97").trigger("click");
  await finishClose();
  assert.equal(wrapper.get(".setting-list-name").text(), "Shared");

  await wrapper.get('[aria-label="AI_EDIT_MODEL"]').trigger("click");
  assert.equal(dialog().get('input[type="password"]').element.value, "");
  await dialog().findAll("input")[0].setValue("Renamed");
  assert.equal(dialog().get("select").element.value, "");
  await dialog().get("select").setValue("true");
  assert.equal(dialog().findAll("select")[1].element.value, "medium");
  await dialog().findAll("select")[1].setValue("high");
  await dialog().get("form").trigger("submit");
  await finishClose();
  assert.equal(wrapper.get(".setting-list-name").text(), "Renamed");
  assert.equal(values.presets[0].id, "shared");
  assert.equal(values.presets[0].thinkingEnabled, true);
  assert.equal(values.presets[0].thinkingEffort, "high");
  assert.equal(saved.length, 0); // Confirming an item must not submit the configuration form.

  await addButton().trigger("click");
  assert.equal(dialog().attributes("title"), "TXT_CODE_a1d885c1");
  assert.equal(dialogButton("TXT_CODE_d507abff").element.disabled, true);
  await dialog().get("form").trigger("submit");
  assert.equal(values.presets.length, 1);
  await dialog().findAll("input")[0].setValue("Discarded new model");
  wrapper.findComponent(components.VDialog).vm.$emit("update:modelValue", false);
  await vue.nextTick();
  await finishClose();
  assert.equal(values.presets.length, 1);

  await addButton().trigger("click");
  const inputs = dialog().findAll("input");
  assert.equal(inputs[0].element.value, "");
  assert.equal(dialog().get("select").element.value, "");
  for (const [i, value] of [
    "New",
    "https://new.example",
    "new-model",
    "NEW_SECRET"
  ].entries())
    await inputs[i].setValue(value);
  assert.equal(values.presets.length, 1);
  assert.equal(dialogButton("TXT_CODE_d507abff").element.disabled, false);
  assert.equal(dialogButton("TXT_CODE_d507abff").attributes("type"), "submit");
  await dialog().get("form").trigger("submit");
  await finishClose();
  assert.equal(wrapper.findAll("input").length, 0);
  assert.deepEqual(
    wrapper.findAll(".setting-list-name").map((row) => row.text()),
    ["Renamed", "New"]
  );
  assert.equal(saved.length, 0);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(saved.at(-1).modelLoopProtection, true);
  assert.equal(saved.at(-1).presets.length, 2);
  assert.equal(saved.at(-1).presets[0].name, "Renamed");
  assert.equal(saved.at(-1).presets[0].apiKey, "KEEP_SECRET");
  assert.equal(saved.at(-1).presets[1].apiKey, "NEW_SECRET");
  assert.equal(saved.at(-1).presets[0].thinkingEnabled, true);
  assert.equal(saved.at(-1).presets[0].thinkingEffort, "high");
  assert.equal(saved.at(-1).presets[1].thinkingEnabled, null);
  assert.equal(saved.at(-1).presets[1].thinkingEffort, "medium");
  assert.doesNotMatch(JSON.stringify(declaration.read()), /KEEP_SECRET|NEW_SECRET/);
  await wrapper.findAll('[aria-label="AI_DELETE_MODEL"]')[1].trigger("click");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal((await models.resolve("alice", "preset:shared", false)).apiKey, "KEEP_SECRET");
  assert.equal(saved.at(-1).presets.length, 1);
  await addButton().trigger("click");
  await dialogButton("TXT_CODE_a0451c97").trigger("click");
  const closingModal = wrapper.findComponent(components.VDialog);
  await wrapper.get('[aria-label="AI_EDIT_MODEL"]').trigger("click");
  closingModal.vm.$emit("afterLeave");
  await vue.nextTick();
  assert.equal(dialog().attributes("title"), "TXT_CODE_ad207008");
  assert.equal(wrapper.findComponent(components.VDialog).props("modelValue"), true);
  await dialog().findAll("input")[0].setValue("Stale draft");
  await wrapper.setProps({ values: vue.reactive(declaration.read()) });
  assert.equal(wrapper.find(".setting-list-editor").exists(), false);
  assert.equal(wrapper.get(".setting-list-name").text(), "Renamed");
  wrapper.unmount();
});

test("the settings shortcut selects this plugin even when configuration is already open on a node", () => {
  const route = { query: {} };
  let onQuery;
  const filename = "panel/plugins/config/src/ConfigPage.vue";
  const descriptor = parse(fs.readFileSync(path.join(root, filename), "utf8"), {
    filename
  }).descriptor;
  const script = compileScript(descriptor, { id: "config-route-test" });
  const entry = load(
    filename,
    {
      vue: {
        ...vue,
        onMounted() {},
        onUnmounted() {},
        watch(source, callback) {
          if (typeof source === "function" && Array.isArray(source()) && source().length === 3)
            onQuery = callback;
        }
      },
      "vue-router": { useRoute: () => route, useRouter: () => ({}), onBeforeRouteLeave() {} },
      "@/lang/i18n": { t: (key) => key },
      "@/plugin/context": { ctx: {} },
      "@/tools/validator": {},
      "@/tools/vuetifyToast": {},
      "vuetify/components": {},
      "./SchemaForm.vue": {},
      "./api": {}
    },
    script.content
  ).default;
  const state = entry.setup({}, { expose() {} });
  state.plugins.value = [{ id: "console" }, { id: "epanel-plugin-elements-ai" }];
  state.selectedId.value = "console";
  state.scope.value = "node";
  onQuery(["panel", undefined, "epanel-plugin-elements-ai"]);
  assert.equal(state.scope.value, "panel");
  assert.equal(state.selectedId.value, "epanel-plugin-elements-ai");
});

test("personal models use a compact list and modal drafts without discarding sidebar settings", async () => {
  const models = [];
  const writes = [];
  const deletes = [];
  let failSave = false;
  const f = sidebar({
    getStatus: async () => ({
      ready: models.length > 0,
      admin: false,
      userId: "alice",
      models: [...models]
    }),
    saveModel: async (input, user) => {
      if (failSave) throw new Error("MODEL_SAVE_FAILED");
      writes.push({ input, user });
      const saved = {
        id: `personal:${input.id || "one"}`,
        source: "personal",
        name: input.name,
        model: input.model,
        endpoint: input.endpoint,
        hasApiKey: true,
        thinkingEnabled: input.thinkingEnabled,
        thinkingEffort: input.thinkingEffort
      };
      const index = models.findIndex((entry) => entry.id === saved.id);
      if (index >= 0) models[index] = saved;
      else models.push(saved);
    },
    deleteModel: async (id, user) => {
      deletes.push({ id, user });
      models.splice(0);
    }
  });
  f.state.open = true;
  await flushPromises();
  assert.equal(f.wrapper.find('[aria-label="AI_MY_MODELS"]').exists(), false);
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.equal(f.wrapper.find(".ai-sidebar-settings .ai-model-manager").exists(), true);
  assert.equal(f.wrapper.find(".ai-sidebar-settings select").exists(), false);
  assert.equal(f.wrapper.find(".ai-model-manager input").exists(), false);
  await f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').setValue(false);
  const button = (text) => f.wrapper.findAll("button").find((entry) => entry.text() === text);
  await button("AI_ADD_MODEL").trigger("click");
  assert.equal(f.wrapper.get(".ai-model-editor").attributes("title"), "AI_ADD_MODEL");
  assert.equal(button("AI_SAVE_MODEL").element.disabled, true);
  await f.wrapper.get('[data-label="AI_MODEL_LABEL"]').setValue("Cancelled model");
  await f.wrapper.get('[data-label="AI_API_KEY"]').setValue("DISCARD_SECRET");
  await f.wrapper.get('[data-label="AI_THINKING_ENABLED"]').setValue("true");
  await f.wrapper.get('[data-label="AI_THINKING_EFFORT"]').setValue("low");
  await button("AI_CANCEL").trigger("click");
  assert.equal(f.wrapper.find(".ai-model-editor").exists(), false);
  assert.equal(writes.length, 0);
  await button("AI_ADD_MODEL").trigger("click");
  assert.equal(f.wrapper.get('[data-label="AI_MODEL_LABEL"]').element.value, "");
  assert.equal(f.wrapper.get('[data-label="AI_API_KEY"]').element.value, "");
  assert.equal(f.wrapper.get('[data-label="AI_THINKING_ENABLED"]').element.value, "");
  assert.equal(f.wrapper.find('[data-label="AI_THINKING_EFFORT"]').exists(), false);
  await f.wrapper.get('[data-label="AI_MODEL_LABEL"]').setValue("My model");
  await f.wrapper
    .get('[data-label="AI_ENDPOINT"]')
    .setValue("https://api.example/v1");
  await f.wrapper.get('[data-label="AI_MODEL"]').setValue("custom");
  await f.wrapper.get('[data-label="AI_API_KEY"]').setValue("PRIVATE_KEY");
  await f.wrapper.get('[data-label="AI_THINKING_ENABLED"]').setValue("true");
  assert.equal(f.wrapper.get('[data-label="AI_THINKING_EFFORT"]').element.value, "medium");
  await f.wrapper.get('[data-label="AI_THINKING_EFFORT"]').setValue("high");
  assert.equal(f.wrapper.findAll("form form").length, 0);
  assert.equal(f.wrapper.findAll(".ai-model-row").length, 0);
  failSave = true;
  await f.wrapper.get(".ai-model-editor form").trigger("submit");
  await flushPromises();
  assert.match(f.wrapper.get(".ai-model-editor").text(), /MODEL_SAVE_FAILED/);
  assert.equal(f.wrapper.get('[data-label="AI_API_KEY"]').element.value, "PRIVATE_KEY");
  assert.equal(writes.length, 0);
  failSave = false;
  await f.wrapper.get(".ai-model-editor form").trigger("submit");
  await flushPromises();
  assert.equal(writes[0].user, "alice");
  assert.equal(writes[0].input.apiKey, "PRIVATE_KEY");
  assert.equal(writes[0].input.thinkingEnabled, true);
  assert.equal(writes[0].input.thinkingEffort, "high");
  assert.equal(f.wrapper.find(".ai-model-editor").exists(), false);
  assert.equal(f.wrapper.get(".ai-model-row").text(), "My model");
  assert.equal(f.wrapper.findAll(".ai-model-actions button").length, 2);
  assert.equal(f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').element.checked, false);
  await f.wrapper.get('[aria-label="AI_BACK_CHAT"]').trigger("click");
  assert.match(f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').text(), /My model/);
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  await f.wrapper.get('[aria-label="AI_EDIT_MODEL"]').trigger("click");
  assert.equal(f.wrapper.get(".ai-model-editor").attributes("title"), "AI_EDIT_MODEL");
  assert.equal(f.wrapper.get('[data-label="AI_MODEL_LABEL"]').element.value, "My model");
  assert.equal(f.wrapper.get('[data-label="AI_MODEL"]').element.value, "custom");
  assert.equal(f.wrapper.get('[data-label="AI_API_KEY"]').element.value, "");
  assert.equal(f.wrapper.get('[data-label="AI_THINKING_ENABLED"]').element.value, "true");
  assert.equal(f.wrapper.get('[data-label="AI_THINKING_EFFORT"]').element.value, "high");
  await f.wrapper.get('[data-label="AI_THINKING_EFFORT"]').setValue("low");
  await f.wrapper.get('[data-label="AI_MODEL_LABEL"]').setValue("Cancelled edit");
  await button("AI_CANCEL").trigger("click");
  assert.equal(f.wrapper.get(".ai-model-row").text(), "My model");
  assert.equal(writes.length, 1);
  await f.wrapper.get('[aria-label="AI_EDIT_MODEL"]').trigger("click");
  await f.wrapper.get('[data-label="AI_MODEL_LABEL"]').setValue("Renamed");
  assert.equal(f.wrapper.get('[data-label="AI_THINKING_EFFORT"]').element.value, "high");
  await f.wrapper.get('[data-label="AI_THINKING_ENABLED"]').setValue("false");
  assert.equal(f.wrapper.find('[data-label="AI_THINKING_EFFORT"]').exists(), false);
  await f.wrapper.get(".ai-model-editor form").trigger("submit");
  await flushPromises();
  assert.equal(writes[1].input.id, "one");
  assert.equal(writes[1].input.apiKey, "");
  assert.equal(writes[1].input.thinkingEnabled, false);
  assert.equal(writes[1].input.thinkingEffort, "high");
  assert.equal(f.wrapper.get(".ai-model-row").text(), "Renamed");
  await f.wrapper.get('[aria-label="AI_DELETE_MODEL"]').trigger("click");
  await button("AI_DELETE_MODEL").trigger("click");
  await flushPromises();
  assert.deepEqual(deletes, [{ id: "one", user: "alice" }]);
  assert.match(f.wrapper.text(), /AI_NO_PERSONAL_MODELS/);
  f.wrapper.unmount();
});

test("the browser SSE reader emits split UTF-8 chunks before the response completes", async () => {
  const oldFetch = global.fetch;
  let controller;
  global.fetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(value) {
        controller = value;
      }
    })
  });
  try {
    const { sendMessage } = load("external/epanel-plugin-elements-ai/panel/src/api.ts", {
      "@elements-panel/sdk": {
        ctx: {
          get: () => ({
            api: {
              userInfoApi: () => ({
                execute: async () => ({ value: { uuid: "alice", token: "token" } })
              })
            }
          })
        }
      }
    });
    const events = [];
    let finished = false;
    const result = sendMessage(
      "Hello",
      undefined,
      "preset:one",
      "alice",
      new AbortController().signal,
      (event) => events.push(event)
    ).then(() => {
      finished = true;
    });
    await flushPromises();
    const bytes = new TextEncoder().encode(
      'data: {"type":"delta","index":1,"content":"你好"}\r\n\r\n'
    );
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    await flushPromises();
    assert.equal(events[0].content, "你好");
    assert.equal(finished, false);
    controller.enqueue(new TextEncoder().encode('data: {"type":"done","conversationId":"id"}\n\n'));
    await result;
  } finally {
    global.fetch = oldFetch;
  }
});

test("selecting a different model preserves the current conversation", async () => {
  const f = sidebar({
    getStatus: async () => ({
      ready: true,
      admin: false,
      userId: "alice",
      models: [
        { id: "preset:default", name: "Shared", model: "one", source: "preset" },
        { id: "personal:mine", name: "Private", model: "two", source: "personal" }
      ]
    })
  });
  f.state.open = true;
  await flushPromises();
  assert.equal(f.wrapper.get('option[value="preset:default"]').text(), "Shared");
  assert.equal(
    f.wrapper.get('option[value="personal:mine"]').text(),
    "Private · AI_PERSONAL_MODEL"
  );
  await f.wrapper.get("textarea").setValue("FIRST CHAT");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').setValue("personal:mine");
  assert.match(f.wrapper.text(), /FIRST CHAT/);
  await f.wrapper.get("textarea").setValue("SECOND CHAT");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(f.calls[0][1], undefined);
  assert.equal(f.calls[1][1], "a".repeat(32));
  assert.equal(f.calls[1][2], "personal:mine");
  f.wrapper.unmount();
});

test("history lists saved chats and restores the selected model and conversation for continuation", async () => {
  const saved = {
    id: "b".repeat(32),
    title: "Saved task",
    modelId: "personal:mine",
    modelName: "Private",
    updatedAt: Date.now(),
    canContinue: true,
    messages: [
      { role: "user", content: "Saved task" },
      { role: "assistant", content: "Saved answer" }
    ]
  };
  const f = sidebar({
    getStatus: async () => ({
      ready: true,
      admin: false,
      userId: "alice",
      models: [
        { id: "preset:default", name: "Shared", model: "one", source: "preset" },
        { id: "personal:mine", name: "Private", model: "two", source: "personal" }
      ]
    }),
    listConversations: async (user) => {
      assert.equal(user, "alice");
      return [saved];
    },
    getConversation: async (id, user) => {
      assert.equal(id, saved.id);
      assert.equal(user, "alice");
      return saved;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_HISTORY"]').trigger("click");
  await flushPromises();
  assert.match(f.wrapper.get(".ai-history-list").text(), /Saved task/);
  await f.wrapper.get(".ai-history-entry").trigger("click");
  await flushPromises();
  assert.match(f.wrapper.get(".ai-messages").text(), /Saved answer/);
  assert.equal(f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').element.value, "personal:mine");
  await f.wrapper.get("textarea").setValue("Continue this task");
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(f.calls[0][1], saved.id);
  assert.equal(f.calls[0][2], "personal:mine");
  f.wrapper.unmount();
});

test("history uses Vuetify buttons and deletes selected conversations in a batch", async () => {
  const saved = {
    id: "e".repeat(32),
    title: "Removable task",
    modelId: "preset:default",
    modelName: "Default",
    updatedAt: Date.now(),
    canContinue: true,
    messages: []
  };
  let deleted;
  const f = sidebar({
    listConversations: async () => [saved],
    deleteConversations: async (ids, user) => {
      deleted = { ids, user };
      return ids.length;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_HISTORY"]').trigger("click");
  await flushPromises();
  assert.equal(f.wrapper.get(".ai-history-entry").element.tagName, "BUTTON");
  assert.equal(f.wrapper.get(".ai-history-select").element.tagName, "INPUT");
  await f.wrapper.get(".ai-history-select").setValue(true);
  await f.wrapper.get('[aria-label="AI_HISTORY_DELETE_SELECTED"]').trigger("click");
  await flushPromises();
  assert.deepEqual(deleted, { ids: [saved.id], user: "alice" });
  assert.equal(f.wrapper.find(".ai-history-entry").exists(), false);
  f.wrapper.unmount();
});

test("history with an unavailable model is readable but cannot send until a new conversation", async () => {
  const saved = {
    id: "c".repeat(32),
    title: "Old task",
    modelId: "preset:removed",
    modelName: "Removed model",
    updatedAt: Date.now(),
    canContinue: false,
    messages: [{ role: "assistant", content: "Old answer" }]
  };
  const f = sidebar({ listConversations: async () => [saved], getConversation: async () => saved });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_HISTORY"]').trigger("click");
  await flushPromises();
  await f.wrapper.get(".ai-history-entry").trigger("click");
  await flushPromises();
  assert.match(f.wrapper.text(), /Old answer/);
  assert.match(f.wrapper.text(), /AI_HISTORY_READ_ONLY/);
  assert.equal(f.wrapper.get("textarea").element.disabled, true);
  await f.wrapper.get("form").trigger("submit");
  assert.equal(f.calls.length, 0);
  await f.wrapper.get('[aria-label="AI_NEW_CHAT"]').trigger("click");
  assert.equal(f.wrapper.get("textarea").element.disabled, false);
  assert.doesNotMatch(f.wrapper.text(), /Old answer/);
  f.wrapper.unmount();
});

test("logout cancels history reads and late results never appear for the next account", async () => {
  const pending = deferred();
  let signal;
  const f = sidebar({
    listConversations: async (_user, value) => {
      signal = value;
      return pending.promise;
    }
  });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get('[aria-label="AI_HISTORY"]').trigger("click");
  f.route.path = "/login";
  await vue.nextTick();
  assert.equal(signal.aborted, true);
  pending.resolve([
    {
      id: "d".repeat(32),
      title: "PRIVATE HISTORY",
      modelId: "preset:default",
      modelName: "Shared",
      updatedAt: Date.now()
    }
  ]);
  await flushPromises();
  f.route.path = "/instances";
  f.state.open = true;
  await flushPromises();
  assert.doesNotMatch(f.wrapper.text(), /PRIVATE HISTORY/);
  f.wrapper.unmount();
});

test("Docker download card displays live percentages above the composer", async (t) => {
  const pending = deferred();
  let emit;
  const f = sidebar({ sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
    emit = onEvent;
    await pending.promise;
  } });
  t.after(() => { pending.resolve(); f.wrapper.unmount(); });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Pull Docker image");
  await f.wrapper.get("form").trigger("submit");
  const update = async (progress) => {
    emit({ type: "download", action: "upsert", task: { id: "docker:test", tool: "pull_docker_image", state: "running", progress } });
    await vue.nextTick();
  };
  await update({});
  assert.equal(f.wrapper.get(".ai-download-detail").text(), "…");
  await update({ value: 37, downloadedBytes: 37, totalBytes: 100 });
  assert.equal(f.wrapper.get(".ai-download-detail").text(), "37% · 37 B / 100 B");
  await update({ value: 68, downloadedBytes: 68, totalBytes: 100 });
  assert.match(f.wrapper.get(".ai-download-detail").text(), /^68%/);
  assert.ok(f.wrapper.html().indexOf('class="ai-downloads') < f.wrapper.html().indexOf('class="ai-composer"'));
});


test("long conversations reuse unchanged rows and coalesce stream scrolling", async (t) => {
  const pending = deferred();
  let emit;
  const f = sidebar({
    sendMessage: async (_message, _conversation, _model, _user, _signal, onEvent) => {
      emit = onEvent;
      await pending.promise;
    }
  });
  t.after(() => { pending.resolve(); f.wrapper.unmount(); });
  f.state.open = true;
  await flushPromises();
  paint();
  await f.wrapper.get("textarea").setValue("Continue");
  await f.wrapper.get("form").trigger("submit");
  emit({ type: "start", conversationId: "a".repeat(32), messages:
    Array.from({ length: 160 }, (_, index) => ({ role: "assistant", content: `History ${index}` }))
  });
  await vue.nextTick();
  paint();
  f.translations.length = 0;
  let scrolls = 0;
  f.wrapper.get(".ai-messages").element.scrollTo = () => scrolls++;
  for (let i = 0; i < 20; i++) {
    emit({ type: "delta", index: 159, content: " next" });
    await vue.nextTick();
  }
  // Only the changing assistant row should evaluate its translated role label.
  assert.equal(f.translations.filter((key) => key === "AI_TITLE").length, 20);
  assert.equal(scrolls, 0);
  paint();
  assert.equal(scrolls, 1);
  assert.equal(f.wrapper.findAll(".ai-message").length, 160);
  assert.equal(f.wrapper.findAll(".ai-text").at(-1).text(), "History 159" + " next".repeat(20));
  emit({ type: "delta", index: 159, content: " hidden" });
  await vue.nextTick();
  f.state.open = false;
  await vue.nextTick();
  paint();
  assert.equal(scrolls, 1);
});

test("running chats allow live settings and queue follow-up input without aborting the stream", async (t) => {
  const pending = deferred();
  let emit;
  let signal;
  let sends = 0;
  const settings = [];
  const inputs = [];
  const f = sidebar({
    getStatus: async () => ({ ready: true, admin: false, userId: "alice", models: [
      { id: "preset:default", name: "Default", source: "preset" },
      { id: "preset:second", name: "Second", source: "preset" }
    ] }),
    sendMessage: async (_message, _conversation, _model, _user, current, onEvent) => {
      sends++;
      signal = current;
      emit = onEvent;
      emit({ type: "start", conversationId: "a".repeat(32), messages: [{ role: "user", content: "Original request" }] });
      await pending.promise;
    },
    updateChatSettings: async (...args) => { settings.push(args); return true; },
    enqueueChatMessage: async (...args) => { inputs.push(args); return true; },
    savePreferences: async () => true
  });
  t.after(() => { pending.resolve(); f.wrapper.unmount(); });
  f.state.open = true;
  await flushPromises();
  await f.wrapper.get("textarea").setValue("Original request");
  await f.wrapper.get("form").trigger("submit");
  assert.equal(f.wrapper.get("textarea").element.disabled, false);
  assert.equal(f.wrapper.get('[aria-label="AI_PERMISSION_MODE"]').element.disabled, false);
  assert.equal(f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').element.disabled, false);
  assert.equal(f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').element.disabled, false);
  await f.wrapper.get('[aria-label="AI_PERMISSION_MODE"]').setValue("full");
  await f.wrapper.get('[aria-label="AI_SELECT_MODEL"]').setValue("preset:second");
  await flushPromises();
  assert.equal(settings.at(-1)[0].modelId, "preset:second");
  assert.equal(settings.at(-1)[0].permissionMode, "full");
  assert.equal(settings.at(-1)[1], "alice");
  assert.equal(signal.aborted, false);
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.equal(f.wrapper.find(".ai-sidebar-settings").exists(), true);
  await f.wrapper.get('input[data-label="AI_SEND_ON_ENTER"]').setValue(false);
  await f.wrapper.get(".ai-sidebar-settings form").trigger("submit");
  await flushPromises();
  assert.equal(signal.aborted, false);
  assert.match(f.wrapper.get(".ai-messages").text(), /Original request/);
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  f.wrapper.findComponent({ name: "ModelManager" }).vm.$emit("changed");
  await flushPromises();
  assert.equal(settings.at(-1)[0].refresh, true);
  assert.equal(signal.aborted, false);
  await f.wrapper.get('[aria-label="AI_CHAT_SETTINGS"]').trigger("click");
  assert.match(f.wrapper.get(".ai-messages").text(), /Original request/);
  await f.wrapper.get("textarea").setValue("Additional instructions");
  assert.equal(f.wrapper.get('[aria-label="AI_SEND"]').element.disabled, false);
  assert.equal(f.wrapper.find('[aria-label="AI_STOP_REPLY"]').exists(), true);
  await f.wrapper.get("form").trigger("submit");
  await flushPromises();
  assert.equal(sends, 1);
  assert.equal(inputs[0][0].message, "Additional instructions");
  assert.equal(inputs[0][0].conversationId, "a".repeat(32));
  assert.match(f.wrapper.get(".ai-messages").text(), /AI_MESSAGE_QUEUED/);
  assert.equal(f.wrapper.get("textarea").element.value, "");
  emit({ type: "input", id: inputs[0][0].id, index: 1, message: { role: "user", content: inputs[0][0].message } });
  await vue.nextTick();
  assert.doesNotMatch(f.wrapper.get(".ai-messages").text(), /AI_MESSAGE_QUEUED/);
  assert.equal(f.wrapper.findAll(".ai-message--user").length, 2);
  assert.equal(signal.aborted, false);
});
