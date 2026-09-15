import { describe, expect, it } from "vitest";

import { nextSequenceId } from "@/lib/followup/next-sequence-id";

describe("nextSequenceId", () => {
  it("continua depois do maior sufixo persistido", () => {
    expect(nextSequenceId(["edge-1", "edge-6", "edge-3"])).toBe(7);
  });

  it("começa em 1 quando não há sufixo numérico", () => {
    expect(nextSequenceId([])).toBe(1);
    expect(nextSequenceId(["edge-legado"])).toBe(1);
  });
});
