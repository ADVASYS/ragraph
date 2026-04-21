import chokidar, { FSWatcher } from "chokidar";
import { statSync } from "node:fs";
import { relative } from "node:path";

export interface WatcherEvent {
  kind: "add" | "change" | "unlink";
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
}

export interface MountWatcherConfig {
  mountId: string;
  universeId: string;
  root: string;
  excludeGlobs: string[];
}

/**
 * Wraps chokidar to emit normalized events for ingestion.
 */
export class MountWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly config: MountWatcherConfig,
    private readonly onEvent: (event: WatcherEvent) => void,
  ) {}

  start(): void {
    const defaults = [
      /(^|[\\/])\../,
      /node_modules/,
      /\.git/,
      /\.DS_Store/,
      /Thumbs\.db/,
    ];
    const ignored: Array<string | RegExp> = [...defaults, ...this.config.excludeGlobs];

    this.watcher = chokidar.watch(this.config.root, {
      ignored,
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
    });

    const handle = (kind: WatcherEvent["kind"]) => (path: string) => {
      try {
        let mtime = 0;
        let size = 0;
        if (kind !== "unlink") {
          const st = statSync(path);
          if (!st.isFile()) return;
          mtime = st.mtimeMs;
          size = st.size;
        }
        this.onEvent({
          kind,
          absPath: path,
          relPath: relative(this.config.root, path),
          mtime,
          size,
        });
      } catch {
        // Ignore transient fs errors
      }
    };

    this.watcher
      .on("add", handle("add"))
      .on("change", handle("change"))
      .on("unlink", handle("unlink"));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
