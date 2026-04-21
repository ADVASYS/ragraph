import { app, BrowserWindow, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import log from "electron-log/main.js";
import { registerAllIpcHandlers } from "./ipc";
import { AppContext } from "./services/AppContext";

const __dirname = dirname(fileURLToPath(import.meta.url));

log.initialize();
log.transports.file.level = "info";
log.transports.console.level = "debug";

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", err);
});

let mainWindow: BrowserWindow | null = null;
let appContext: AppContext | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#fafafa",
    title: "RAGraph",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  try {
    appContext = await AppContext.create();
    registerAllIpcHandlers(appContext);
    await createWindow();
    if (mainWindow) appContext.attachWindow(mainWindow);
  } catch (err) {
    log.error("Failed to start app", err);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  try {
    await appContext?.dispose();
  } catch (err) {
    log.error("Failed to dispose app context", err);
  }
});
