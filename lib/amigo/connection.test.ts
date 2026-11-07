import { expect, it } from "vitest";
import { checkConnection } from "./connection";
it("numeric selections require their original connection and never fall through to a replacement account", () => {
  expect(() => checkConnection("new", "old", true)).toThrow();
  expect(() => checkConnection("new", undefined, true)).toThrow();
  expect(() => checkConnection("new", "new", true)).not.toThrow();
  expect(() => checkConnection("new", undefined, false)).not.toThrow();
});
