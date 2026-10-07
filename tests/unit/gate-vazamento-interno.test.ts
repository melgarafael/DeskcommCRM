import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { MAX_VETOS_DE_VOCABULARIO_INTERNO } from "@/lib/agent-engine/agent/inbound-turn";
import {
  BEFORE_SEND_GATES,
  internalVocabularyGate,
  runBeforeSend,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * O GATE de vazamento de vocabulário interno (`docs/doctrine/separacao-fala-e-operacao.md`).
 * Puro/síncrono (`evaluate` não faz I/O), como os irmãos da cadeia.
 *
 * `baseCtx` é próprio deste arquivo — o repo não tem fixture compartilhada de
 * `GateContext`, e isso é deliberado: uma fixture comum faria um gate herdar o contexto
 * calibrado para outro, e o dia em que ela mudasse, todos os gates mudariam de teste sem
 * ninguém pedir.
 */
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-08-04T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

describe("internalVocabularyGate — arma só onde há modelo para ensinar", () => {
  it("veta o vazamento medido quando armado", () => {
    const v = internalVocabularyGate.evaluate(
      baseCtx({
        internalVocabularyEnforced: true,
        body: "seu perfil atual é agent, e essa alteração exige permissão de manager",
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("internal_vocabulary_leak");
  });

  it("DESARMADO (campo ausente) é no-op — o default não pode calar ninguém", () => {
    // A direção segura AQUI é o oposto da do `messaging_window`. Lá, campo esquecido
    // produz veto visível; aqui, veto num caminho sem modelo (follow-up determinístico)
    // é DROP SILENCIOSO — o atendimento some sem sintoma, matando por dentro o
    // invariante 4 do sistema vivo. Ausente = passa, e o vazamento segue medido a zero.
    const v = internalVocabularyGate.evaluate(
      baseCtx({ body: "chamei crm_list_webhook_sources e não achei nada" }),
    );
    expect(v.pass).toBe(true);
  });

  it("armado + fala legítima = passa (a frase-modelo aprovada do repo)", () => {
    const v = internalVocabularyGate.evaluate(
      baseCtx({
        internalVocabularyEnforced: true,
        body:
          "A etapa «Retorno pos-cirurgico» ainda não existe no funil, mas não consigo " +
          "criá-la por aqui. Peça para alguém do time adicioná-la no fim do funil.",
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("a razão do veto diz a SAÍDA e NOMEIA o termo, não só o problema", () => {
    // A cadeia devolve `reason` ao modelo como erro instrutivo. Um veto que apenas nega
    // faz o modelo tentar de novo igual, e aí o fail-safe libera um texto que ninguém
    // melhorou — a rede vira desculpa em vez de medição.
    const v = internalVocabularyGate.evaluate(
      baseCtx({ internalVocabularyEnforced: true, body: "chamei crm_list_webhook_sources e não achei" }),
    );
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).toContain("crm_list_webhook_sources");
    expect(v.reason).toMatch(/REESCREVA/);
  });

  it("o detail vai ao trace SEM o termo — só contagem e categoria", () => {
    // `detail` é logado e persistido em `before_send_traces`. Termo casado é trecho da
    // candidata (um snake_case pode ter vindo de um dado do lead); categoria é rótulo
    // nosso, de vocabulário fechado. A medição que a doutrina pede cabe nos dois campos.
    const v = internalVocabularyGate.evaluate(
      baseCtx({ internalVocabularyEnforced: true, body: "erro no webhook do crm_list_leads" }),
    );
    if (v.pass) throw new Error("inalcançável");
    // `crm_list_leads` casa por FORMA (snake_case) e por ser tool do catálogo — as duas
    // categorias entram, e é isso que dá ao operador a leitura do que vazou.
    expect(v.detail).toEqual({ leaked_count: 2, leaked_kinds: "arquitetura,snake_case,tool" });
    expect(JSON.stringify(v.detail)).not.toContain("crm_list_leads");
  });

  it("está na cadeia global e é o mesmo objeto exportado", () => {
    // Sem isto, o gate poderia ser testado à exaustão e nunca rodar em produção.
    expect(BEFORE_SEND_GATES).toContain(internalVocabularyGate);
  });
});

/**
 * A PROPAGAÇÃO pela cadeia REAL (sem `gates:` injetado).
 *
 * Provar o gate isolado prova a decisão, não o caminho: `enforceInternalVocabulary`
 * precisa atravessar `RunBeforeSendArgs` → `GateContext` → gate → veto → trace
 * persistido. Um campo que morresse no meio deixaria todos os testes acima verdes e o
 * gate desligado em produção. O par abaixo é a guarda de vacuidade: MESMO corpo, MESMA
 * cadeia — só o flag muda, e o desfecho vira de `vetoed` para `sent`.
 *
 * Pool/cliente falsos no molde de `tests/unit/gate-pacing-capability.test.ts`: o que se
 * exercita é o runner de verdade, não um gate de mentira.
 */
const COMERCIAL = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça — dentro da janela

function chamaCadeiaReal(args: { body: string; armado: boolean }): {
  run: ReturnType<typeof runBeforeSend>;
  inserts: ReturnType<typeof vi.fn>;
} {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const inserts = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
  const pool = { connect: vi.fn().mockResolvedValue(client), query: inserts } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    inserts,
    run: runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: args.body,
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: COMERCIAL,
      rng: () => 0,
      sleep: async () => {},
      ...(args.armado ? { enforceInternalVocabulary: true } : {}),
      send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
    }),
  };
}

const VAZA = "chamei crm_list_webhook_sources e não achei nada";

describe("a cadeia REAL barra o vazamento — e só quando armada", () => {
  it("armada: veta no gate certo e a linha do trace leva a categoria", async () => {
    const { run, inserts } = chamaCadeiaReal({ body: VAZA, armado: true });
    const r = await run;
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("internal_vocabulary");
    expect(r.code).toBe("internal_vocabulary_leak");
    // O trace é o PRODUTO deste gate: é por ele que "acho que vaza" vira número.
    expect(r.trace).toContainEqual({
      gate: "internal_vocabulary",
      verdict: "veto",
      code: "internal_vocabulary_leak",
      detail: { leaked_count: 1, leaked_kinds: "snake_case,tool" },
    });
    // E a medição sobrevive ao rollback do veto: escrita autônoma em before_send_traces.
    // O pool também lê a preferência de estilo (antes de tomar conexão): o
    // trace é a chamada de INSERT, não a primeira chamada ao pool.
    const trace = inserts.mock.calls.find((c) => /insert into before_send_traces/.test(String(c[0])));
    expect(trace, "nenhum insert em before_send_traces").toBeDefined();
    expect(trace?.[1]).toContain("internal_vocabulary_leak");
  });

  it("DESARMADA: o MESMO corpo é enviado — o flag é o que decide, e ele chega", async () => {
    const r = await chamaCadeiaReal({ body: VAZA, armado: false }).run;
    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({ gate: "internal_vocabulary", verdict: "pass" });
  });
});

/**
 * FIAÇÃO — nos dois sentidos.
 *
 * Um gate desarmado por default falha ABERTO: quem esquecer o campo perde o guarda em
 * silêncio, e nenhum teste de comportamento do gate acusaria. E o inverso é pior: se
 * alguém armá-lo no caminho determinístico, o veto vira drop silencioso de follow-up.
 *
 * `runAgentTurn` não tem seam de teste isolável sem harness pesado (o repo já registra
 * isso em `tests/invariants/case-guardrail.test.ts` para o fail-safe irmão), então a
 * asserção é sobre a FONTE — o mesmo recurso que `tests/unit/send-template-wiring.test.ts`
 * usa. É guarda de ligação, não prova de execução: o fail-safe rodando ponta-a-ponta
 * continua sem cobertura mecânica, e isso está dito, não escondido.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);
const FONTE_FOLLOWUP = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/followup-turn.ts"),
  "utf8",
);

/** Recorta o `execute` de uma tool para as asserções não casarem noutro lugar do arquivo. */
function corpoDoExecute(ancora: string, fim: string): string {
  const i = FONTE_INBOUND.indexOf(ancora);
  expect(i, `âncora \`${ancora}\` sumiu do turno`).toBeGreaterThan(-1);
  const j = FONTE_INBOUND.indexOf(fim, i);
  expect(j, `âncora de fim \`${fim}\` sumiu`).toBeGreaterThan(i);
  return FONTE_INBOUND.slice(i, j);
}

describe("fiação do gate — armado no agente, desarmado onde o veto seria silêncio", () => {
  it("send_message ARMA o gate", () => {
    expect(corpoDoExecute("send_message: tool({", "update_lead_state: tool({"))
      .toMatch(/enforceInternalVocabulary:\s*true/);
  });

  it("o follow-up determinístico NÃO arma — lá o veto é drop silencioso", () => {
    // Decisão de desenho, não esquecimento: `followup-turn.ts` chama a cadeia sem modelo
    // no laço. Um veto ali não vira erro instrutivo — vira follow-up que nunca aconteceu.
    expect(FONTE_FOLLOWUP).not.toMatch(/enforceInternalVocabulary/);
  });

  it("send_template NÃO arma — o texto é do humano e já aprovado pela Meta", () => {
    // Vetar aqui devolveria ao modelo a culpa por uma frase que não é dele, e a única
    // saída seria o silêncio: ele não pode reescrever um template aprovado.
    expect(corpoDoExecute("send_template: tool({", "search_knowledge: tool({"))
      .not.toMatch(/enforceInternalVocabulary/);
  });

  it("o fail-safe existe: conta vetos e, ao persistir, libera DESARMANDO só este gate", () => {
    // O cliente nunca fica sem resposta. E "liberar" é re-rodar a cadeia inteira com
    // este gate desarmado — nunca chamar o canal por fora (perderia stop/LGPD/pacing).
    const corpo = corpoDoExecute("send_message: tool({", "update_lead_state: tool({");
    expect(corpo).toMatch(/chain\.code === 'internal_vocabulary_leak'/);
    expect(corpo).toMatch(/internalVocabularyVetoCount \+= 1/);
    expect(corpo).toMatch(/internalVocabularyVetoCount < MAX_VETOS_DE_VOCABULARIO_INTERNO/);
    expect(corpo).toMatch(/runBeforeSend\(\{[\s\S]*?enforceInternalVocabulary: false/);
  });

  it("o teto do fail-safe deixa ao menos UMA chance de reescrita antes de liberar", () => {
    // 1 significaria "veta e já libera" — o modelo nunca veria o erro instrutivo, e o
    // gate seria só telemetria. 2 é o mesmo degrau do fail-safe de casos humanos.
    expect(MAX_VETOS_DE_VOCABULARIO_INTERNO).toBeGreaterThanOrEqual(2);
  });
});
