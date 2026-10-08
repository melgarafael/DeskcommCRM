/**
 * O TURNO SÓ PAGA CLASSIFICADOR QUANDO HÁ O QUE CLASSIFICAR — E PAGA MENOS.
 *
 * Três propriedades:
 *
 *  1. `classificadoresDoTurno`: estágio e manipulação só no turno da mensagem
 *     NOVA (ou na prévia); estágio só com `update_lead_state` no conversador;
 *     manipulação nunca sobre mensagem vazia.
 *  2. A FIAÇÃO: o `Promise.all` do turno consulta essa decisão — sem isto a
 *     função pura passaria verde enquanto o turno continuava pagando.
 *  3. `buildClassifierMessage`: o classificador de estágio lê texto corrido
 *     das últimas mensagens + resumo + proposta, sem telefone, e-mail, ids nem
 *     carimbos — o que antes ia como `JSON.stringify(context)` inteiro.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classificadoresDoTurno } from "@/lib/agent-engine/agent/classificadores-do-turno";
import {
  buildClassifierMessage,
  MENSAGENS_PARA_O_ESTAGIO,
} from "@/lib/agent-engine/agent/stage-classifier";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

const base = {
  jobKind: "inbound_turn" as string | null,
  estagioLigado: true,
  temQuemConfirmeOEstagio: true,
  manipulacaoLigada: true,
  ultimaMensagemDoCliente: "quanto custa o plano anual?",
};

describe("classificadoresDoTurno", () => {
  it("turno da mensagem nova: os dois rodam", () => {
    expect(classificadoresDoTurno(base)).toEqual({ estagio: true, manipulacao: true });
  });

  it("a prévia (sem job) simula mensagem nova e classifica", () => {
    expect(classificadoresDoTurno({ ...base, jobKind: null })).toEqual({ estagio: true, manipulacao: true });
  });

  it("follow-up e resposta de caso não reclassificam a mensagem que o turno dela já classificou", () => {
    for (const jobKind of ["followup_turn", "case_reply_turn"]) {
      expect(classificadoresDoTurno({ ...base, jobKind }), jobKind).toEqual({ estagio: false, manipulacao: false });
    }
  });

  it("estágio sem quem o confirme (update_lead_state com o Operador) não é pago", () => {
    expect(classificadoresDoTurno({ ...base, temQuemConfirmeOEstagio: false })).toEqual({
      estagio: false,
      manipulacao: true,
    });
  });

  it("mensagem vazia não vai ao classificador de manipulação", () => {
    expect(classificadoresDoTurno({ ...base, ultimaMensagemDoCliente: "   " }).manipulacao).toBe(false);
  });

  it("knob e camada desligados continuam mandando", () => {
    expect(classificadoresDoTurno({ ...base, estagioLigado: false, manipulacaoLigada: false })).toEqual({
      estagio: false,
      manipulacao: false,
    });
  });
});

describe("a fiação no turno", () => {
  const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
  const inicio = fonte.indexOf("const [stageResultado, jailbreakVerdict, manipulacaoDoJev] = await Promise.all([");
  const array = fonte.slice(inicio, fonte.indexOf("perguntaAoJev,\n    ])", inicio));

  it("o Promise.all dos classificadores existe onde este teste procura", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(array).toContain("classifyStage(");
    expect(array).toContain("classifyJailbreak(");
  });

  it("cada classificador é condicionado pela decisão de `classificadoresDoTurno`", () => {
    const antesDoEstagio = array.slice(0, array.indexOf("classifyStage("));
    const antesDaManipulacao = array.slice(array.indexOf("Promise.resolve(null),"), array.indexOf("classifyJailbreak("));
    expect(antesDoEstagio).toMatch(/vaiClassificar\.estagio\s*\?\s*$/);
    expect(antesDaManipulacao).toMatch(/vaiClassificar\.manipulacao\s*\?\s*$/);
    expect(fonte).toMatch(/const vaiClassificar = classificadoresDoTurno\(\{/);
  });

  it("o classificador de estágio recebe o resumo do checkpoint vigente", () => {
    expect(array).toMatch(/resumo: effectivePrevious\?\.rolling_summary \?\? null,/);
  });
});

function contexto(n: number, over: Partial<LeadContext> = {}): LeadContext {
  return {
    lead_id: "6f1c2b8e-1111-4111-8111-111111111111",
    contact: {
      name: "Maria",
      phone: "+5511987654321",
      email: "maria@exemplo.com",
      tags: ["vip"],
      is_blocked: false,
    },
    conversation_id: "6f1c2b8e-2222-4222-8222-222222222222",
    last_human_decision: null,
    messages: Array.from({ length: n }, (_, i) => ({
      direction: i % 2 === 0 ? ("inbound" as const) : ("outbound" as const),
      body: `mensagem ${i}`,
      sent_at: "2026-09-02T15:45:38-03:00",
      media_storage_path: null,
    })),
    ...over,
  };
}

describe("buildClassifierMessage", () => {
  it("não carrega telefone, e-mail, ids nem carimbos de hora", () => {
    const texto = buildClassifierMessage(contexto(4), "contacted");
    expect(texto).not.toContain("+5511987654321");
    expect(texto).not.toContain("maria@exemplo.com");
    expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(texto).not.toContain("2026-09-02");
    expect(texto).toContain("cliente: mensagem 0");
    expect(texto).toContain("loja: mensagem 1");
  });

  it("lê só as últimas mensagens — o que veio antes chega pelo resumo", () => {
    const texto = buildClassifierMessage(contexto(30), "qualifying", "Quer 3 licenças, decide com o sócio.");
    expect(texto).toContain(`mensagem ${30 - MENSAGENS_PARA_O_ESTAGIO}`);
    expect(texto).not.toContain(`mensagem ${30 - MENSAGENS_PARA_O_ESTAGIO - 1}\n`);
    expect(texto).toContain("## Resumo do que veio antes\nQuer 3 licenças, decide com o sócio.");
  });

  it("resumo vazio não abre seção", () => {
    expect(buildClassifierMessage(contexto(2), "new", "  ")).not.toContain("Resumo");
  });

  it("corta mensagem longa (um PDF não decide estágio pelo tamanho)", () => {
    const longo = contexto(1);
    longo.messages[0]!.body = "x".repeat(5000);
    const texto = buildClassifierMessage(longo, "new");
    expect(texto.length).toBeLessThan(2500);
    expect(texto).toContain("…");
  });

  it("leva o desfecho da última proposta, que separa negociação de ganho/perda", () => {
    const texto = buildClassifierMessage(
      contexto(2, {
        last_proposal: { status: "recusada", total_cents: 100, decision_reason: "achou caro", numero: 1, ano: 2026 },
      }),
      "negotiating",
    );
    expect(texto).toContain("## Última proposta\nrecusada (motivo: achou caro)");
  });

  it("fica bem menor que o JSON inteiro de antes", () => {
    const ctx = contexto(20);
    expect(buildClassifierMessage(ctx, "contacted").length).toBeLessThan(JSON.stringify(ctx).length * 0.6);
  });
});
