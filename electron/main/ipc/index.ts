import { AppContext } from "../services/AppContext";
import { registerSettingsHandlers } from "./settings";
import { registerUniverseHandlers } from "./universes";
import { registerMountHandlers } from "./mounts";
import { registerFileHandlers } from "./files";
import { registerChatHandlers } from "./chats";
import { registerGraphHandlers } from "./graph";
import { registerMemoryHandlers } from "./memory";
import { registerDocumentHandlers } from "./documents";
import { registerWebSourceHandlers } from "./webSources";

export function registerAllIpcHandlers(ctx: AppContext): void {
  registerSettingsHandlers(ctx);
  registerUniverseHandlers(ctx);
  registerMountHandlers(ctx);
  registerWebSourceHandlers(ctx);
  registerFileHandlers(ctx);
  registerChatHandlers(ctx);
  registerGraphHandlers(ctx);
  registerMemoryHandlers(ctx);
  registerDocumentHandlers(ctx);
}
