import { describe, expect, it } from "vitest";

import {
  __test_fitToBudget,
  historicoComOModeloFixado,
} from "@/lib/agent-engine/edge/crm/get-lead-context";

// O último modelo aprovado que o cliente recebeu entra no histórico mesmo de
// fora da janela (`tests/invariants/agente-ve-o-ultimo-modelo-enviado.test.ts`
// prova a consulta). Aqui, as duas regras puras: a cópia fixada não duplica a
// que já está na janela, e no orçamento de tokens ela é a ÚLTIMA a cair — é dela
// que sai o preço que o cliente está aceitando.
const base = {
  lead_id: "l1",
  contact: { name: "x", phone: null, email: null, tags: [], is_blocked: false },
  conversation_id: "c1",
  last_human_decision: null,
};
const linha = (id: string, body: string, minuto: number, extra: { type?: string; fixado?: boolean } = {}) => ({
  id,
  direction: (extra.type === "template" ? "outbound" : "inbound") as "inbound" | "outbound",
  type: extra.type ?? "text",
  body,
  media_url: null,
  media_storage_path: null,
  media_mime: null,
  media_derived_text: null,
  sent_at: new Date(Date.UTC(2026, 9, 21, 12, minuto)),
  metadata: null,
  ...(extra.fixado ? { fixado: true } : {}),
});

describe("historicoComOModeloFixado", () => {
  it("fora da janela: entra, em ordem cronológica", () => {
    const daMaisNova = [linha("m2", "sim", 2), linha("m1", "oi", 1), linha("t", "OFERTA", 0, { type: "template", fixado: true })];
    expect(historicoComOModeloFixado(daMaisNova).map((l) => l.body)).toEqual(["OFERTA", "oi", "sim"]);
  });

  it("já na janela: a cópia fixada sai e nada se repete", () => {
    const daMaisNova = [
      linha("m2", "sim", 2),
      linha("t", "OFERTA", 1, { type: "template" }),
      linha("t", "OFERTA", 1, { type: "template", fixado: true }),
    ];
    expect(historicoComOModeloFixado(daMaisNova).map((l) => l.body)).toEqual(["OFERTA", "sim"]);
  });
});

describe("fitToBudget — o modelo fixado é o último a cair", () => {
  const longa = "x".repeat(400);
  const historico = [
    linha("t", "OFERTA_COM_DESCONTO", 0, { type: "template", fixado: true }),
    linha("m1", `ANTIGA ${longa}`, 1),
    linha("m2", `MEIO ${longa}`, 2),
    linha("m3", "sim, quero", 3),
  ];

  it("com o orçamento apertado, caem as antigas e a oferta fica", () => {
    const ctx = __test_fitToBudget(base, historico, 260, "America/Sao_Paulo");
    const corpos = ctx.messages.map((m) => m.body);
    expect(corpos[0]).toBe("OFERTA_COM_DESCONTO");
    expect(corpos.at(-1)).toBe("sim, quero");
    expect(corpos.some((c) => c.startsWith("ANTIGA"))).toBe(false);
  });

  it("controle: sem a marca, a mesma linha seria a primeira a cair", () => {
    const semMarca = historico.map(({ fixado: _f, ...l }) => l);
    const ctx = __test_fitToBudget(base, semMarca, 260, "America/Sao_Paulo");
    expect(ctx.messages.map((m) => m.body)).not.toContain("OFERTA_COM_DESCONTO");
  });
});
