/**
 * In-memory state for sessions + settlement events, with a periodic JSON snapshot so the
 * cumulative /impact numbers survive restarts (mirrors how Driplet kept a durable proof feed).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, SettlementEvent, StreamSpec } from "../../shared/types.ts";

interface Snapshot {
  sessions: Session[];
  events: SettlementEvent[];
}

export class Store {
  private sessions = new Map<string, Session>();
  private events: SettlementEvent[] = [];
  private dirty = false;

  constructor(
    public readonly streams: Map<string, StreamSpec>,
    private readonly snapshotPath: string,
  ) {
    this.load();
    // Flush at most once a second; cheap and keeps the proof feed durable.
    setInterval(() => this.flush(), 1000).unref();
  }

  private load(): void {
    try {
      if (!existsSync(this.snapshotPath)) return;
      const snap = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as Snapshot;
      for (const s of snap.sessions ?? []) this.sessions.set(s.id, s);
      this.events = snap.events ?? [];
    } catch (err) {
      console.warn("⚠️  could not load snapshot, starting fresh:", (err as Error).message);
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      const snap: Snapshot = { sessions: [...this.sessions.values()], events: this.events };
      writeFileSync(this.snapshotPath, JSON.stringify(snap));
      this.dirty = false;
    } catch (err) {
      console.warn("⚠️  snapshot flush failed:", (err as Error).message);
    }
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  putSession(s: Session): void {
    this.sessions.set(s.id, s);
    this.dirty = true;
  }

  addEvent(e: SettlementEvent): void {
    this.events.push(e);
    this.dirty = true;
  }

  recentEvents(limit: number): SettlementEvent[] {
    return this.events.slice(-limit).reverse();
  }

  activeSessionCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === "active") n++;
    return n;
  }

  /** Cumulative totals across all settlements ever recorded. */
  totals(): { settlements: number; totalPaid: bigint; uniqueAgents: number; secondsStreamed: number } {
    let totalPaid = 0n;
    let secondsStreamed = 0;
    const agents = new Set<string>();
    for (const e of this.events) {
      totalPaid += BigInt(e.amount);
      secondsStreamed += e.seconds;
      agents.add(e.agent);
    }
    return { settlements: this.events.length, totalPaid, uniqueAgents: agents.size, secondsStreamed };
  }
}
