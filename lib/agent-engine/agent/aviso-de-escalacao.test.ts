/**
 * O TIPO do envio decide a janela do aviso de escalação (#2112, seguimento do
 * #2031/#1985).
 *
 * `avisarLeadDaEscalacao` mandava `resposta: true` FIXO para a cadeia. É o
 * certo para o turno de inbound — o aviso responde a quem escreveu e pediu
 * pessoa — e errado para a escalação que nasce DENTRO de um follow-up: ali é
 * disparo (retomada), e a janela que vale é a de `window_*`, não a de
 * `resposta_*` (#0495). Com a janela de resposta mais estreita que a de
 * disparo, o aviso de quem pediu pessoa no meio de um disparo era vetado pelo
 * lado errado — e `before_send_traces` registrava um veto que a janela real não
 * daria.
 *
 * O que se mede aqui: qual `resposta` chega em `runBeforeSend`, por origem.
 * Os caminhos estão nos TRÊS chamadores (`inbound-turn.ts` lê
 * `eTurnoDeResposta(job)`), e o default é `resposta` de propósito: chamador que
 * não declara origem é o caminho de resposta de #1984.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runBeforeSend = vi.hoisted(() =>
  vi.fn(
    async (_args: Record<string, unknown>) =>
      ({ status: "sent", outcome: { kind: "sent" }, trace: [] }) as never,
  ),
);
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ quem: null, frase: "" })),
}));
vi.mock("@/lib/escalacao/aviso-ao-lead", () => ({
  textoDoAviso: vi.fn(() => "Uma pessoa vai te atender."),
}));
vi.mock("@/lib/agent-engine/guardrails/lgpd/legal-basis", () => ({
  deriveLgpdFromContact: vi.fn(() => ({})),
}));

import {
  avisarLeadDaEscalacao,
  avisarLeadLendoOContato,
  type AvisoDeEscalacaoOpts,
} from "./aviso-de-escalacao";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

const ids = {
  tenantId: ORG,
  leadId: "33333333-3333-4333-8333-333333333333",
  conversationId: "44444444-4444-4444-8844-444444444444",
  channelSessionId: CANAL,
  jobId: "job",
};

const pool = { query: async () => ({ rows: [] }) } as never;

function opts(extra: Partial<AvisoDeEscalacaoOpts> = {}): AvisoDeEscalacaoOpts {
  return {
    motivo: "pediu_humano",
    channel: {} as never,
    optedOutThisTurn: false,
    now: new Date("2026-09-20T06:00:00Z"),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...extra,
  };
}

/** O único argumento `runBeforeSend` recebeu desde o início do teste. */
function ultimoEnvio(): Record<string, unknown> {
  const chamadas = runBeforeSend.mock.calls;
  expect(chamadas.length).toBeGreaterThan(0);
  return chamadas[chamadas.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => {
  runBeforeSend.mockReset();
  runBeforeSend.mockImplementation(
    async () => ({ status: "sent", outcome: { kind: "sent" }, trace: [] }) as never,
  );
});

describe("aviso de escalação: qual janela a cadeia avalia", () => {
  it("sem origem declarada, sai como RESPOSTA — o default de #1984 não muda", async () => {
    await avisarLeadDaEscalacao(pool, ids, opts());
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(ultimoEnvio().resposta).toBe(true);
  });

  it("origem `resposta` explícita → `resposta: true` (janela `resposta_*`)", async () => {
    await avisarLeadDaEscalacao(pool, ids, opts({ origem: "resposta" }));
    expect(ultimoEnvio().resposta).toBe(true);
  });

  it("origem `disparo` (escalação dentro de um follow-up) → `resposta: FALSE`", async () => {
    // É o caso do #2112: dentro de um follow-up ninguém escreveu nada agora,
    // então o aviso NÃO pode ser julgado pela janela de resposta.
    await avisarLeadDaEscalacao(pool, ids, opts({ origem: "disparo" }));
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(ultimoEnvio().resposta).toBe(false);
  });

  it("o disparo segue passando o resto do contrato — só a janela muda", async () => {
    await avisarLeadDaEscalacao(pool, ids, opts({ origem: "disparo" }));
    const args = ultimoEnvio();
    expect(args.resposta).toBe(false);
    // Mesmas proteções do caminho de resposta: o aviso é a ÚNICA mensagem que
    // desarma o gate de spinning, e o corpo continua saindo pela cadeia.
    expect(args.enforceSpinning).toBe(false);
    expect(typeof args.body).toBe("string");
    expect(args.channelSessionId).toBe(CANAL);
  });

  it("`avisarLeadLendoOContato` (orçamento, caminho sem turno na mão) repassa a origem", async () => {
    await avisarLeadLendoOContato(pool, ids, opts({ origem: "disparo" }));
    expect(ultimoEnvio().resposta).toBe(false);

    await avisarLeadLendoOContato(pool, ids, opts());
    expect(ultimoEnvio().resposta).toBe(true);
  });

  it("veto da cadeia vira desfecho de não-avisado — e a origem do disparo é a que chegou lá", async () => {
    runBeforeSend.mockResolvedValueOnce({
      status: "vetoed",
      code: "messaging_window_closed",
      trace: [],
    } as never);
    const desfecho = await avisarLeadDaEscalacao(pool, ids, opts({ origem: "disparo" }));
    expect(ultimoEnvio().resposta).toBe(false);
    expect(desfecho).toEqual({
      avisado: false,
      porque: "messaging_window_closed",
      motivoCodigo: "fora_da_janela",
    });
  });
});
