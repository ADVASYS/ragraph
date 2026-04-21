import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import { fetchModels, testProvider } from "../core/providers/LLMProvider";
import type { ProviderConfig, AppSettings } from "../../../shared/types";

export function registerSettingsHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Settings.Get, () => ctx.getSettings());
  ipcMain.handle(IPC.Settings.Update, (_e, patch: Partial<AppSettings>) => ctx.updateSettings(patch));
  ipcMain.handle(IPC.Settings.TestProvider, async (_e, config: Pick<ProviderConfig, "baseUrl" | "apiKey">) => {
    return await testProvider(config);
  });
  ipcMain.handle(IPC.Settings.FetchModels, async (_e, config: Pick<ProviderConfig, "baseUrl" | "apiKey">) => {
    return await fetchModels(config);
  });
}
