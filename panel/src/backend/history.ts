import type { PanelPluginContext } from "../../../../../panel/src/app/plugin";
import type { ChatMessage } from "../types";
import type { ModelMessage } from "./provider";

export interface Conversation {
  owner: string;
  scope: string;
  model: string;
  modelName: string;
  title: string;
  target?: string;
  touched: number;
  turns: ModelMessage[][];
  visible: ChatMessage[];
}

export interface SavedConversation extends Conversation {
  id: string;
}

class HistoryData {
  entries: SavedConversation[] = [];
}

/** The owner always comes from the authenticated account, never from request data. */
export class HistoryStore {
  constructor(private ctx: PanelPluginContext) {}

  async list(owner: string): Promise<SavedConversation[]> {
    const saved: HistoryData | null = await this.ctx.storage
      .getStorage()
      .load("EpanelPluginElementsAiHistory", HistoryData, owner);
    return (saved?.entries || []).filter((entry) => entry.owner === owner);
  }

  async get(owner: string, id: string): Promise<SavedConversation | undefined> {
    return (await this.list(owner)).find((entry) => entry.id === id);
  }

  // ChatService holds the account's request lock until this write completes.
  async save(id: string, conversation: Conversation): Promise<void> {
    const entries = (await this.list(conversation.owner)).filter((entry) => entry.id !== id);
    entries.push({ ...conversation, id });
    entries.sort((a, b) => b.touched - a.touched);
    await this.ctx.storage
      .getStorage()
      .store("EpanelPluginElementsAiHistory", conversation.owner, { entries: entries.slice(0, 50) });
  }

  async remove(owner: string, ids: ReadonlySet<string>, scope: string): Promise<number> {
    const entries = await this.list(owner);
    const removed = entries.filter((entry) => entry.scope === scope && ids.has(entry.id));
    if (!removed.length) return 0;
    await this.ctx.storage.getStorage().store("EpanelPluginElementsAiHistory", owner, {
      entries: entries.filter((entry) => !(entry.scope === scope && ids.has(entry.id)))
    });
    return removed.length;
  }
}
