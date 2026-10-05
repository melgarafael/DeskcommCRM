import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { MAX_VETOS_DE_AFIRMACAO_CLINICA } from "@/lib/agent-engine/agent/inbound-turn";
import {
  BEFORE_SEND_GATES,
  clinicalClaimGate,
  runBeforeSend,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * O GATE de afirmação clínica (`clinical_claim`). O detector tem os próprios casos em
 * `lib/agent-engine/guardrails/afirmacao-clinica.test.ts`; aqui se prova o resto do
 * caminho: o gate, a cadeia real, a fiação no turno e o fail-safe.
 *
 * `baseCtx` próprio, pela mesma razão de `gate-vazamento-interno.test.ts`.
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

const AFIRMA = "Pela foto, você tem uma micose de unha. Passe uma pomada antifúngica.";

describe("clinicalClaimGate — só arma para quem ligou a camada", () => {
  it("armado: veta a afirmação clínica", () => {
    const v = clinicalClaimGate.evaluate(baseCtx({ clinicalClaimEnforced: true, body: AFIRMA }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("clinical_claim");
    expect(v.reason).toMatch(/ofereça o agendamento/);
  });

  it("DESARMADO (campo ausente) é no-op — organização que não é de saúde não sente nada", () => {
    expect(clinicalClaimGate.evaluate(baseCtx({ body: AFIRMA })).pass).toBe(true);
  });

  it("armado + rotina da recepção passa", () => {
    const v = clinicalClaimGate.evaluate(
      baseCtx({
        clinicalClaimEnforced: true,
        body: "Você tem preferência de dia ou horário? O diagnóstico é feito em consulta.",
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("o detail vai ao trace SEM o texto — só as categorias", () => {
    // `detail` é persistido em `before_send_traces`. A frase pode citar a queixa do
    // paciente (dado de saúde); a categoria é rótulo nosso, de vocabulário fechado.
    const v = clinicalClaimGate.evaluate(baseCtx({ clinicalClaimEnforced: true, body: AFIRMA }));
    if (v.pass) throw new Error("inalcançável");
    expect(v.detail).toEqual({ clinical_kinds: "diagnostico,prescricao" });
    expect(JSON.stringify(v.detail)).not.toMatch(/micose|pomada/);
  });

  it("está na cadeia global e é o mesmo objeto exportado", () => {
    expect(BEFORE_SEND_GATES).toContain(clinicalClaimGate);
  });
});

/** A PROPAGAÇÃO pela cadeia REAL: o mesmo corpo, só o flag muda, e o desfecho vira. */
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
      ...(args.armado ? { enforceClinicalClaim: true } : {}),
      send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
    }),
  };
}

describe("a cadeia REAL barra a afirmação clínica — e só quando armada", () => {
  it("armada: veta no gate certo e o trace leva só as categorias", async () => {
    const { run, inserts } = chamaCadeiaReal({ body: AFIRMA, armado: true });
    const r = await run;
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("clinical_claim");
    expect(r.code).toBe("clinical_claim");
    expect(r.trace).toContainEqual({
      gate: "clinical_claim",
      verdict: "veto",
      code: "clinical_claim",
      detail: { clinical_kinds: "diagnostico,prescricao" },
    });
    const sql = String(inserts.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/insert into before_send_traces/);
  });

  it("DESARMADA: o MESMO corpo é enviado", async () => {
    const r = await chamaCadeiaReal({ body: AFIRMA, armado: false }).run;
    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({ gate: "clinical_claim", verdict: "pass" });
  });
});

/**
 * FIAÇÃO — asserção sobre a FONTE, como em `gate-vazamento-interno.test.ts`: o turno
 * não tem seam isolável. É guarda de ligação, não prova de execução ponta-a-ponta.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);
const FONTE_FOLLOWUP = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/followup-turn.ts"),
  "utf8",
);
const FONTE_PREVIEW = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/preview.ts"),
  "utf8",
);

function corpoDoExecute(ancora: string, fim: string): string {
  const i = FONTE_INBOUND.indexOf(ancora);
  expect(i, `âncora \`${ancora}\` sumiu do turno`).toBeGreaterThan(-1);
  const j = FONTE_INBOUND.indexOf(fim, i);
  expect(j, `âncora de fim \`${fim}\` sumiu`).toBeGreaterThan(i);
  return FONTE_INBOUND.slice(i, j);
}

describe("fiação do gate — a escolha da organização chega ao send_message", () => {
  it("send_message arma pela camada da organização, com padrão desligado", () => {
    expect(corpoDoExecute("send_message: tool({", "update_lead_state: tool({")).toMatch(
      /enforceClinicalClaim:\s*camadaLigada\(camadas\.afirmacao_clinica,\s*false\)/,
    );
  });

  it("o follow-up determinístico NÃO arma — lá o veto seria drop silencioso", () => {
    expect(FONTE_FOLLOWUP).not.toMatch(/enforceClinicalClaim/);
  });

  it("send_template NÃO arma — o texto é do humano e já aprovado pela Meta", () => {
    expect(corpoDoExecute("send_template: tool({", "search_knowledge: tool({")).not.toMatch(
      /enforceClinicalClaim/,
    );
  });

  it("o fail-safe abre caso e NUNCA libera a frase desarmando o gate", () => {
    // Ao contrário do vocabulário interno, não existe "diagnóstico, mas melhor que
    // silêncio": a insistência chama a equipe, não solta a mensagem.
    const corpo = corpoDoExecute("send_message: tool({", "update_lead_state: tool({");
    expect(corpo).toMatch(/chain\.code === 'clinical_claim'/);
    expect(corpo).toMatch(/clinicalClaimVetoCount \+= 1/);
    expect(corpo).toMatch(/clinicalClaimVetoCount >= MAX_VETOS_DE_AFIRMACAO_CLINICA/);
    const bloco = corpo.slice(corpo.indexOf("chain.code === 'clinical_claim'"));
    expect(bloco.slice(0, bloco.indexOf("internal_vocabulary_leak"))).toMatch(/openCase\(/);
    expect(FONTE_INBOUND).not.toMatch(/enforceClinicalClaim:\s*false/);
  });

  it("o teto do fail-safe deixa ao menos UMA chance de reescrita", () => {
    expect(MAX_VETOS_DE_AFIRMACAO_CLINICA).toBeGreaterThanOrEqual(2);
  });

  it("o preview do agente arma igual ao turno real — senão o teste na tela mente", () => {
    expect(FONTE_PREVIEW).toMatch(/lerCamadasDaOrg/);
    expect(FONTE_PREVIEW).toMatch(/clinicalClaimEnforced:/);
  });
});
