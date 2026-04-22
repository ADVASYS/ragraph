import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Centralized filesystem layout for the application data directory.
 * All paths are created lazily when first accessed.
 */
export class StoragePaths {
  constructor(public readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  get metaDb(): string {
    return join(this.root, "meta.sqlite");
  }

  get graphRoot(): string {
    const p = join(this.root, "graph");
    mkdirSync(p, { recursive: true });
    return p;
  }

  graphDb(universeId: string): string {
    return join(this.graphRoot, `${universeId}.sqlite`);
  }

  get lanceRoot(): string {
    const p = join(this.root, "lance");
    mkdirSync(p, { recursive: true });
    return p;
  }

  lanceDb(universeId: string): string {
    const p = join(this.lanceRoot, universeId);
    mkdirSync(p, { recursive: true });
    return p;
  }

  get cacheRoot(): string {
    const p = join(this.root, "cache");
    mkdirSync(p, { recursive: true });
    return p;
  }

  get modelsRoot(): string {
    const p = join(this.root, "models");
    mkdirSync(p, { recursive: true });
    return p;
  }

  get attachmentsRoot(): string {
    const p = join(this.root, "attachments");
    mkdirSync(p, { recursive: true });
    return p;
  }

  get webCacheRoot(): string {
    const p = join(this.root, "web");
    mkdirSync(p, { recursive: true });
    return p;
  }

  webCacheDir(universeId: string, sourceId: string): string {
    const p = join(this.webCacheRoot, universeId, sourceId);
    mkdirSync(p, { recursive: true });
    return p;
  }
}
