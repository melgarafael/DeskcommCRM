import { describe, expect, it } from "vitest";
import definition from "./strobi.avatar.json";

/**
 * Guarda da definição do Strobi: `AssistenteAvatar` usa estas animações e
 * expressões por NOME. Se alguém sobrescrever o `.avatar.json` com outra
 * exportação do Lab que não tenha alguma delas, a lib recusaria em runtime e
 * o ajudante cairia no fallback — este teste quebra antes, no CI.
 */
describe("strobi.avatar.json — chaves usadas pelo assistente", () => {
  it("tem as animações idle, listening e happy", () => {
    for (const a of ["idle", "listening", "happy"] as const) {
      expect(definition.animationOrder).toContain(a);
      expect(definition.animations).toHaveProperty(a);
    }
  });

  it("tem as expressões de olhar, a neutra e a do pisca", () => {
    for (const e of [
      "neutral",
      "eyes-closed",
      "far-right-glance",
      "curious-left",
      "upward-side-glance",
      "downward-gaze",
    ] as const) {
      expect(definition.expressionOrder).toContain(e);
      expect(definition.expressions).toHaveProperty(e);
    }
  });
});
