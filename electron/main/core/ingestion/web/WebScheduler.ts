/**
 * Periodic ticker that runs auto-refreshes of `WebSource`s whose
 * `next_scan_at` has elapsed. Ticker resolution is deliberately coarse (every
 * 5 minutes) because refresh intervals are measured in hours.
 */
export class WebScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly intervalMs = 5 * 60 * 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.safeTick(), this.intervalMs);
    // Run one tick immediately after startup (delayed to let boot finish).
    setTimeout(() => void this.safeTick(), 30_000).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch {
      // Tick errors are already logged by the caller; swallow so the timer survives.
    } finally {
      this.running = false;
    }
  }
}
