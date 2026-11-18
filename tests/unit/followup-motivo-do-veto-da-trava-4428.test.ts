/**
 * O MOTIVO DO CANCELAMENTO DIZ QUE FOI A TRAVA DE REPETIÇÃO.
 *
 * ## O defeito (#4428)
 *
 * Quando o passo `ai_message` do follow-up é vetado pela trava anti-ban
 * (`spinning`, código `mass_identical`), a inscrição era cancelada com o texto
 * genérico "O assistente concluiu este passo sem enviar uma mensagem. Revise o
 * próximo passo." Quem abre a inscrição não descobre que houve VETO — nem qual
 * trava segurou, nem quantas repetições o veto contou.
 *
 * O dado já existia em dois pontos e não se encontravam:
 *
 *   - o veto (`decideSpinning`) devolve `code: 'mass_identical'` com a contagem
 *     de repetições (`matchCount`);
 *   - a tentativa vira linha em `before_send_traces` (`vetoed_gate`,
 *     `vetoed_code`, `trace`), escrita ANTES do ledger — por isso o
 *     `send_ledger` não tem linha e o ramo `status = 'vetoed'` de
 *     `resultadoDoEnvioDoFollowup` nunca era atingido.
 *
 * ## O que este arquivo prende
 *
 * - o veto da trava chega ao motivo com a CONTAGEM que ele carrega, e o texto
 *   genérico deixa de aparecer nesse caso;
 * - a contagem viaja no TRACE do veto (`detail.matchCount`) — é o elo que
 *   liga `before-send` ao ponto que grava o motivo;
 * - as OUTRAS causas de cancelamento continuam com o texto de hoje: sem veto
 *   registrado, veto de outra trava, linha de ledger `vetoed` e veto sem
 *   contagem no trace.
 *
 * ## O que NÃO prova
 *
 * Nada com Postgres real: o dublê de pool devolve as linhas que o banco
 * devolveria. A consulta em si (colunas, `order by created_at desc limit 1`) é
 * conferida na revisão do diff, não aqui.
 */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import {
  MOTIVO_DO_VETO_DA_TRAVA_DE_REPETICAO,
  resultadoDoEnvioDoFollowup,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import { evaluateBeforeSend, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { hashNormalized, normalizeCopy } from "@/lib/agent-engine/spinning/engine";
import { DICIONARIO } from "@/lib/i18n/dicionario";

/** O texto de HOJE — o que continua valendo para toda causa que não é a trava. */
const GENERICO =
  "O assistente concluiu este passo sem enviar uma mensagem. Revise o próximo passo.";

/** Corpo do passo de IA — longo o bastante para não cair na isenção de copy curta. */
const CORPO =
  "Oi, Maria! Passando para confirmar se você consegue vir na consulta de amanhã às 15h.";

type LinhaDoTraco = {
  vetoed_gate: string | null;
  vetoed_code: string | null;
  trace: unknown;
};

/**
 * O pool do caminho real: a cadeia `before_send` veta ANTES de gravar no ledger,
 * então `send_ledger` volta vazio e o único rastro é `before_send_traces`.
 * `traco = null` = nenhum veto registrado para este job.
 */
function pool(traco: LinhaDoTraco | null, statusDoLedger: string[] = []) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/from send_ledger/.test(sql))
        return { rows: statusDoLedger.map((status) => ({ status })) };
      if (/from before_send_traces/.test(sql)) return { rows: traco === null ? [] : [traco] };
      return { rows: [] };
    }),
  };
}

/** O trace como `persistTrace` grava: um registro por gate, `detail` só no veto que o traz. */
function traceDoVeto(contagem: number | undefined) {
  return [
    { gate: "stop", verdict: "pass" },
    { gate: "pacing", verdict: "pass" },
    {
      gate: "spinning",
      verdict: "veto",
      code: "mass_identical",
      ...(contagem === undefined ? {} : { detail: { matchCount: contagem } }),
    },
    { gate: "promise", verdict: "skipped" },
  ];
}

describe("o motivo do cancelamento nomeia a trava de repetição (#4428)", () => {
  it("o veto da trava chega ao motivo com a contagem que ele carrega", async () => {
    const r = await resultadoDoEnvioDoFollowup(
      pool({
        vetoed_gate: "spinning",
        vetoed_code: "mass_identical",
        trace: traceDoVeto(3),
      }) as never,
      "org",
      "job",
    );

    expect(r.kind).toBe("skipped");
    const motivo = (r as { kind: "skipped"; reason: string }).reason;
    expect(motivo).toMatch(/trava de repetição/);
    expect(motivo).toMatch(/3 vez/);
    expect(motivo).not.toContain("{n}");
    expect(motivo).not.toBe(GENERICO);
  });
});

describe("o veto da trava carrega a contagem no trace (#4428)", () => {
  /** O contexto mínimo da cadeia real: cópia dos dublês de `preview.test.ts`. */
  const contexto = (): GateContext => ({
    now: new Date("2026-09-07T15:00:00Z"),
    body: CORPO,
    optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER,
    messagingWindow: { lastInboundAt: new Date("2026-09-07T14:00:00Z") },
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: {
      knobs: SPINNING_DEFAULTS,
      // A 3ª cópia do mesmo texto na janela do número — o caso da issue.
      window: [CORPO, CORPO, CORPO].map((texto) => ({
        normalizedText: normalizeCopy(texto),
        normalizedHash: hashNormalized(normalizeCopy(texto)),
      })),
    },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
  });

  it("o gate spinning veta com matchCount no detail — sem ele o motivo não teria o número", () => {
    const { veto, trace } = evaluateBeforeSend(contexto());

    expect(veto?.code).toBe("mass_identical");
    const linha = trace.find((entrada) => entrada.gate === "spinning");
    expect(linha?.verdict).toBe("veto");
    expect(linha?.detail?.matchCount).toBe(3);
  });
});

describe("as outras causas de cancelamento continuam com o texto de hoje (#4428)", () => {
  it("sem veto registrado, o motivo é o genérico de sempre", async () => {
    const r = await resultadoDoEnvioDoFollowup(pool(null) as never, "org", "job");

    expect(r).toEqual({ kind: "skipped", reason: GENERICO });
  });

  it("veto de outra trava não vira motivo de repetição", async () => {
    const r = await resultadoDoEnvioDoFollowup(
      pool({
        vetoed_gate: "pacing",
        vetoed_code: "daily_cap",
        trace: [{ gate: "pacing", verdict: "veto", code: "daily_cap" }],
      }) as never,
      "org",
      "job",
    );

    expect(r).toEqual({ kind: "skipped", reason: GENERICO });
  });

  it("linha de ledger vetada mantém o texto do ramo de hoje", async () => {
    const r = await resultadoDoEnvioDoFollowup(pool(null, ["vetoed"]) as never, "org", "job");

    expect(r).toEqual({
      kind: "skipped",
      reason: "O envio foi recusado pelas regras do atendimento.",
    });
  });

  it("veto da trava sem contagem no trace não inventa número", async () => {
    const r = await resultadoDoEnvioDoFollowup(
      pool({
        vetoed_gate: "spinning",
        vetoed_code: "mass_identical",
        trace: traceDoVeto(undefined),
      }) as never,
      "org",
      "job",
    );

    expect(r).toEqual({ kind: "skipped", reason: GENERICO });
  });
});

describe("o motivo novo sai traduzido no idioma de quem lê (#4428)", () => {
  it("a frase do motivo tem espanhol no dicionário", () => {
    // A tela do Dossiê mostra o motivo por `t()`; sem entrada aqui, quem lê em
    // espanhol continuaria vendo português — o mesmo cuidado do motivo da vaga
    // ocupada (`MOTIVO_DA_VAGA_OCUPADA_DEMAIS`).
    expect(DICIONARIO[MOTIVO_DO_VETO_DA_TRAVA_DE_REPETICAO]?.es).toBeTruthy();
  });
});
