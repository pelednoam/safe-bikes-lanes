import { describe, expect, it } from "vitest";

import { hook } from "../src/app/hooks.js";

describe("a hook", () => {
  it("calls what was set, with its arguments, and returns its answer", () => {
    const add = hook<[number, number], number>("add");
    add.set((a, b) => a + b);
    expect(add.call(2, 3)).toBe(5);
  });

  it("says which one it was when called before it was set", () => {
    expect(() => hook("frameRoute").call()).toThrow("hook frameRoute was called before it was set");
  });

  it("can't be set twice: two modules claiming one name is a mistake", () => {
    const h = hook("replan");
    h.set(() => undefined);
    expect(() => h.set(() => undefined)).toThrow("hook replan was set twice");
  });
});
