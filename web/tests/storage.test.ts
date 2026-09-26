// localStorage without the exceptions: full, blocked, and corrupt stores.
import { afterEach, describe, expect, it } from "vitest";

import { readItem, readJson, removeItem, trimRecord, writeItem } from "../src/storage.js";

class MemoryStorage {
  store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
}

const g = globalThis as unknown as { localStorage?: unknown };

afterEach(() => {
  delete g.localStorage;
});

describe("storage helpers", () => {
  it("read and write through when storage works", () => {
    g.localStorage = new MemoryStorage();
    expect(writeItem("k", "v")).toBe(true);
    expect(readItem("k")).toBe("v");
    removeItem("k");
    expect(readItem("k")).toBeNull();
  });

  it("with site data blocked, every call is harmless", () => {
    const refuse = (): never => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    g.localStorage = { getItem: refuse, setItem: refuse, removeItem: refuse };
    expect(readItem("avoidTypes")).toBeNull();
    expect(writeItem("avoidTypes", "[]")).toBe(false);
    expect(() => removeItem("avoidTypes")).not.toThrow();
    expect(readJson("avoidTypes", ["x"])).toEqual(["x"]);
  });

  it("with no storage object at all, too", () => {
    expect(readItem("k")).toBeNull();
    expect(writeItem("k", "v")).toBe(false);
  });

  it("a corrupt value reads as the fallback", () => {
    g.localStorage = new MemoryStorage();
    writeItem("avoidTypes", "{not json");
    expect(readJson<string[]>("avoidTypes", [])).toEqual([]);
  });
});

describe("trimRecord", () => {
  it("keeps the newest entries of a cache that has outgrown its cap", () => {
    const rec: Record<string, string> = {};
    for (let i = 0; i < 10; i++) rec[`-71.${i},42.3`] = `street ${i}`;
    const kept = trimRecord(rec, 3);
    expect(Object.values(kept)).toEqual(["street 7", "street 8", "street 9"]);
  });

  it("leaves a small cache alone", () => {
    const rec = { a: "1" };
    expect(trimRecord(rec, 3)).toBe(rec);
  });
});
