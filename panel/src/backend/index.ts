import type { PanelPluginContext } from "../../../../../panel/src/app/plugin";
import { localeMessages } from "../i18n";
import { ChatService } from "./chat";
import { ModelSettingsError, registerSettings } from "./settings";
import { PreferencesStore } from "./preferences";
import { PanelTools } from "./tools";
import { streamChat } from "./stream";

// Explicitly depend on the account guard: AI operations stop when auth unloads.
export const inject = [
  "koa",
  "i18n",
  "storage",
  "settingsForm",
  "middleware",
  "roles",
  "identity",
  "guard",
  "remote",
  "operations"
];

export async function apply(ctx: PanelPluginContext) {
  ctx.i18n.define(localeMessages);
  const models = await registerSettings(ctx);
  const preferences = new PreferencesStore(ctx);
  const chat = new ChatService(ctx, models);
  ctx.on("dispose", () => chat.dispose());
  const router = ctx.koa.router("/api/ai");
  const permission = ctx.middleware.permission({ level: ctx.roles.USER });
  router.get("/status", permission, async (request) => {
    const identity = new PanelTools(ctx, request).identity();
    const [available, personalSettings] = await Promise.all([
      models.list(identity.uuid),
      preferences.read(identity.uuid)
    ]);
    const current = new PanelTools(ctx, request).identity();
    if (current.uuid !== identity.uuid) throw new ModelSettingsError(ctx.i18n.$t("AI_FORBIDDEN"));
    request.body = {
      ready: available.length > 0,
      admin: current.elevated,
      models: available,
      userId: identity.uuid,
      preferences: personalSettings
    };
  });
  router.put("/preferences", permission, async (request) => {
    const identity = new PanelTools(ctx, request).identity();
    const value = preferences.validate(request.request.body);
    if (new PanelTools(ctx, request).identity().uuid !== identity.uuid)
      throw new ModelSettingsError(ctx.i18n.$t("AI_FORBIDDEN"));
    await preferences.save(identity.uuid, value);
    request.body = true;
  });
  router.put("/models", permission, async (request) => {
    const identity = new PanelTools(ctx, request).identity();
    await models.save(identity.uuid, request.request.body, identity.elevated);
    request.body = true;
  });
  router.get("/conversations", permission, async (request) => {
    request.body = await chat.listHistory(request);
  });
  router.get("/conversations/:id", permission, async (request) => {
    request.body = await chat.readHistory(request, request.params.id);
  });
  router.delete("/conversations", permission, async (request) => {
    const body = request.request.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ModelSettingsError(ctx.i18n.$t("AI_INVALID_TOOL"));
    request.body = await chat.deleteHistory(request, body.ids);
  });
  router.delete("/models/:id", permission, async (request) => {
    const identity = new PanelTools(ctx, request).identity();
    await models.remove(identity.uuid, request.params.id);
    request.body = true;
  });
  router.post("/chat", permission, (request) => {
    streamChat(request, (emit) => chat.chat(request, emit), ctx.i18n.$t("AI_REQUEST_FAILED"));
  });
  router.post("/chat/input", permission, (request) => {
    request.body = chat.enqueueMessage(request);
  });
  router.put("/chat/settings", permission, async (request) => {
    request.body = await chat.updateSettings(request);
  });
  router.post("/approvals/:id", permission, (request) => {
    chat.respondToApproval(request, request.params.id, request.request.body);
    request.body = true;
  });
  router.post("/questions/:id", permission, (request) => {
    chat.respondToQuestion(request, request.params.id, request.request.body);
    request.body = true;
  });
}
