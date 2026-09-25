import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiResponseHandler } from "@/workers/ai-response-worker.handler";

describe("a IA nunca responde em grupo", () => {
  it("o worker de resposta não escuta o evento de grupo", () => {
    expect(aiResponseHandler.events).not.toContain("message.group_received");
    expect(aiResponseHandler.events).toEqual(["message.received"]);
  });
  it("o motor do agente mantém a guarda de conversa de grupo (segunda camada)", () => {
    const drain = readFileSync("lib/agent-engine/edge/crm/drain.ts", "utf8");
    expect(drain).toMatch(/is_group !== false/);
  });
});
