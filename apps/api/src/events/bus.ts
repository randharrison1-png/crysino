import { EventEmitter } from "node:events";
import type { RoundView } from "../games/engine.js";

/**
 * In-process event bus for live updates. With more than one API server this becomes Redis
 * pub/sub (same interface), so every server's WebSocket clients see every bet.
 */
export interface BusEvents {
  round_settled: { userId: string; round: RoundView; balance: bigint };
}

export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0);

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }
}
