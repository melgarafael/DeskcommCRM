import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";

describe("provider openai-codex", () => {
  it("oferecido na tela e executável no registry", () => {
    expect(ehProvedorSuportado("openai-codex")).toBe(true);
    expect(createDefaultRegistry()["openai-codex"]).toBeTypeOf("function");
  });
});
