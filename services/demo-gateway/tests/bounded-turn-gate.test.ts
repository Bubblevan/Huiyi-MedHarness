import { describe, expect, it } from "vitest";
import { BoundedTurnGate } from "../src/backends/bounded-turn-gate.js";

function deferred<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("BoundedTurnGate", () => {
  it("runs at most the configured number of operations and releases queued work in order", async () => {
    const gate = new BoundedTurnGate(2);
    const firstWave = deferred();
    const firstWaveStarted = deferred();
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const tasks = [0, 1, 2, 3].map((id) => gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(id);
      if (active === 2) firstWaveStarted.resolve();
      if (id < 2) await firstWave.promise;
      active -= 1;
      return id;
    }));

    await firstWaveStarted.promise;
    expect(active).toBe(2);
    expect(order).toEqual([0, 1]);
    firstWave.resolve();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(gate.peakActiveCount).toBe(2);
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });

  it("cancels queued work without consuming a slot or invoking the operation", async () => {
    const gate = new BoundedTurnGate(1);
    const hold = deferred();
    const started = deferred();
    const first = gate.run(async () => { started.resolve(); await hold.promise; });
    await started.promise;

    const controller = new AbortController();
    let invoked = false;
    const queued = gate.run(async () => { invoked = true; }, controller.signal);
    controller.abort(new Error("cancelled while queued"));
    await expect(queued).rejects.toThrow("cancelled while queued");
    hold.resolve();
    await first;
    expect(invoked).toBe(false);
  });

  it("releases a slot after failure and validates its bound", async () => {
    const gate = new BoundedTurnGate(1);
    await expect(gate.run(async () => { throw new Error("expected failure"); })).rejects.toThrow("expected failure");
    await expect(gate.run(async () => "available")).resolves.toBe("available");
    expect(() => new BoundedTurnGate(0)).toThrow(/from 1 to 4/);
    expect(() => new BoundedTurnGate(5)).toThrow(/from 1 to 4/);
  });
});
