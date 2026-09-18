import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inboundEhDestaPergunta, textoDoPayloadInbound } from "./aplicar-inbound";

describe("textoDoPayloadInbound", () => {
  it("lê body_preview do evento emitido pelo banco", () => {
    expect(textoDoPayloadInbound({ body_preview: "  Ian  ", contact_id: "x" })).toBe("Ian");
  });

  it("vazio quando o payload não traz texto", () => {
    expect(textoDoPayloadInbound({ contact_id: "x" })).toBe("");
  });

  it("lê body cru quando não há preview", () => {
    expect(textoDoPayloadInbound({ body: "sim" })).toBe("sim");
  });
});

describe("inboundEhDestaPergunta", () => {
  it("o SIM da pergunta anterior não conta na espera seguinte", () => {
    expect(inboundEhDestaPergunta("2026-08-25T18:11:00.000Z", "2026-08-25T19:18:00.000Z")).toBe(false);
  });

  it("a resposta depois da pergunta conta", () => {
    expect(inboundEhDestaPergunta("2026-08-25T19:25:00.000Z", "2026-08-25T19:19:00.000Z")).toBe(true);
  });
});

describe("aplicarTextoNosFollowups — uma mensagem, uma pergunta", () => {
  const fonte = () => readFileSync(join(process.cwd(), "lib/followup/aplicar-inbound.ts"), "utf8");

  it("filtra waiting_reply com inboundEhDestaPergunta (não reaproveita texto velho)", () => {
    const src = fonte();
    expect(src).toMatch(/inboundEhDestaPergunta\(enviadaEm, enrollment\.updated_at\)/);
    expect(src).toMatch(/if \(!enviadaEm \|\| !inboundEhDestaPergunta/);
  });

  it("não tem 2ª passada cega fora do loop (regressão: confirm + endereço no mesmo request)", () => {
    const src = fonte();
    // Uma chamada só, dentro do for — a 2ª passada solta reaplicava o texto
    // que enfileirou a confirmação de nome como se fosse o SIM.
    const chamadas = src.match(/await aplicarTextoAosEnrollmentsEmEspera\(/g) ?? [];
    expect(chamadas.length).toBe(1);
    expect(src).toMatch(/for \(let i = 0; i < 6; i\+\+\) \{[\s\S]*aplicarTextoAosEnrollmentsEmEspera/);
  });

  it("não processa enrollment de pointer surface='atendimento' (0242)", () => {
    // O fluxo de ATENDIMENTO é conduzido pelo TURNO; o motor de follow-up o
    // cancelava em nome do follow-up (medido ao vivo, 2026-09-18). As DUAS
    // consultas (waiting_reply e active-due) precisam do corte por surface.
    const src = fonte();
    expect(src).toMatch(/pointersDeAtendimento/);
    expect(src).toMatch(/surface", "atendimento"/);
    // Os dois laços cortam pelo set antes de processar.
    const cortes = src.match(/atendimento\.has\(enrollment\.pointer_id\)/g) ?? [];
    expect(cortes.length).toBeGreaterThanOrEqual(2);
  });
});
