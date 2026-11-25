/**
 * O limite de resposta que a rede impõe, na cadeia `before_send` (A21, TikTok).
 *
 * A conta em si (48 h, 10, reserva de 2) é provada em
 * `lib/channels/social/limites-da-rede.test.ts`. Aqui se prova a COLA:
 *
 *  1. rede sem limite medido paga UMA leitura da sessão e o gate registra
 *     `skipped: 'not_applicable'` (invariante 4 da doutrina) — nenhum outro canal
 *     muda de destino;
 *  2. a contagem sai de `messages` filtrando saída e `failed`, na conversa certa;
 *  3. leitura quebrada nunca derruba o turno (`undefined` + aviso no log);
 *  4. o gate traduz o veredito da regra pura em veto com a SAÍDA no texto.
 */
import { describe, expect, it, vi } from "vitest";

import type { GateContext } from "../guardrails/before-send";
import {
  carregarLimiteDaRede,
  configDoAgenteNaRede,
  limiteDaRedeGate,
  tetosDeEnvioDoTurno,
} from "./limite-da-rede";

const AGORA = new Date("2026-11-25T12:00:00.000Z");
const HORA = 60 * 60 * 1000;
const ENTRADA = { organizationId: "org-1", contactId: "contato-1", channelSessionId: "sessao-1" };

type Linhas = Record<string, unknown>[];
function fakeDb(respostas: { sessao: Linhas; conversa?: Linhas; contagem?: Linhas }) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("from channel_sessions")) return { rows: respostas.sessao };
    if (sql.includes("from conversations")) return { rows: respostas.conversa ?? [] };
    if (sql.includes("from messages")) return { rows: respostas.contagem ?? [{ total: 0 }] };
    throw new Error(`consulta inesperada: ${sql}`);
  });
  return { query } as unknown as Parameters<typeof carregarLimiteDaRede>[0] & { query: typeof query };
}

describe("carregarLimiteDaRede", () => {
  it("rede sem limite medido: UMA leitura da sessão e `undefined`", async () => {
    for (const rede of [null, "instagram", "facebook"]) {
      const db = fakeDb({ sessao: [{ rede }] });
      expect(await carregarLimiteDaRede(db, ENTRADA)).toBeUndefined();
      expect(db.query).toHaveBeenCalledTimes(1);
    }
  });

  it("TikTok: lê a conversa e conta as mensagens da empresa desde a última do cliente", async () => {
    const ultima = new Date(AGORA.getTime() - 2 * HORA);
    const db = fakeDb({
      sessao: [{ rede: "tiktok" }],
      conversa: [{ id: "conv-1", last_inbound_at: ultima }],
      contagem: [{ total: 7 }],
    });
    const lido = await carregarLimiteDaRede(db, ENTRADA);
    expect(lido).toMatchObject({ respostasNaJanela: 7, limites: { maxRespostas: 10 } });
    expect(lido?.lastInboundAt?.getTime()).toBe(ultima.getTime());

    const sqlDaContagem = String(db.query.mock.calls[2]?.[0]);
    // saída da empresa, sem as que falharam, na conversa lida e desde a última do cliente
    expect(sqlDaContagem).toMatch(/direction = 'outbound'/);
    expect(sqlDaContagem).toMatch(/status <> 'failed'/);
    expect(sqlDaContagem).toMatch(/conversation_id = \$2/);
    expect(sqlDaContagem).toMatch(/coalesce\(m\.sent_at, m\.created_at\) >= \$3/);
    expect(db.query.mock.calls[2]?.[1]).toEqual(["org-1", "conv-1", ultima]);
  });

  it("TikTok sem conversa ou sem mensagem do cliente: contagem 0 e SEM a terceira leitura", async () => {
    const semConversa = fakeDb({ sessao: [{ rede: "tiktok" }], conversa: [] });
    expect(await carregarLimiteDaRede(semConversa, ENTRADA)).toMatchObject({
      respostasNaJanela: 0,
      lastInboundAt: null,
    });
    expect(semConversa.query).toHaveBeenCalledTimes(2);

    const nuncaEscreveu = fakeDb({
      sessao: [{ rede: "tiktok" }],
      conversa: [{ id: "conv-1", last_inbound_at: null }],
    });
    expect(await carregarLimiteDaRede(nuncaEscreveu, ENTRADA)).toMatchObject({ lastInboundAt: null });
    expect(nuncaEscreveu.query).toHaveBeenCalledTimes(2);
  });

  it("banco fora: nunca lança, devolve `undefined` e deixa o aviso no log", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("conexão caiu")) } as never;
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    await expect(carregarLimiteDaRede(db, { ...ENTRADA, log })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function ctxCom(limiteDaRede: GateContext["limiteDaRede"]): GateContext {
  return { now: AGORA, ...(limiteDaRede !== undefined ? { limiteDaRede } : {}) } as unknown as GateContext;
}
const limites = { janelaMs: 48 * HORA, maxRespostas: 10, reservaParaEquipe: 2, fotosPorTurnoDaIa: 2 };
const haHoras = (h: number) => new Date(AGORA.getTime() - h * HORA);

describe("limiteDaRedeGate", () => {
  it("rede sem limite: passa com `skipped: not_applicable`, nunca um `pass` mudo", () => {
    expect(limiteDaRedeGate.evaluate(ctxCom(undefined))).toEqual({ pass: true, skipped: "not_applicable" });
  });

  it("leitura da contagem falhou: passa com `skipped: nao_conferido` (fail-open com registro)", () => {
    const v = limiteDaRedeGate.evaluate(
      ctxCom({ limites, respostasNaJanela: null, lastInboundAt: haHoras(1) }),
    );
    expect(v).toEqual({ pass: true, skipped: "nao_conferido" });
  });

  it("a IA passa com 7 respostas e é vetada com 8 — o veto diz a saída e leva os números", () => {
    const passa = limiteDaRedeGate.evaluate(
      ctxCom({ limites, respostasNaJanela: 7, lastInboundAt: haHoras(1) }),
    );
    expect(passa).toEqual({ pass: true });

    const veto = limiteDaRedeGate.evaluate(
      ctxCom({ limites, respostasNaJanela: 8, lastInboundAt: haHoras(1) }),
    );
    expect(veto).toMatchObject({
      pass: false,
      code: "reserva_da_equipe",
      detail: { na_janela: 8, teto: 10, reserva_da_equipe: 2 },
    });
    if (!veto.pass) expect(veto.reason).toMatch(/Encerre o turno e deixe a conversa para uma pessoa/);
  });

  it("janela de 48 h vencida veta com o código da janela, mesmo com a contagem em zero", () => {
    const veto = limiteDaRedeGate.evaluate(
      ctxCom({ limites, respostasNaJanela: 0, lastInboundAt: haHoras(49) }),
    );
    expect(veto).toMatchObject({ pass: false, code: "janela_da_rede_fechada" });
  });
});

describe("o turno da IA numa rede com limite próprio", () => {
  const tiktok = { janelaMs: 48 * HORA, maxRespostas: 10, reservaParaEquipe: 2, fotosPorTurnoDaIa: 2 };

  it("a IA não divide a resposta em bolhas: splitMessages vira false, o resto da config fica", () => {
    const config = { splitMessages: true, splitMaxChars: 600, nome: "Sofia" };
    expect(configDoAgenteNaRede(config, tiktok)).toEqual({ splitMessages: false, splitMaxChars: 600, nome: "Sofia" });
    // não muda o objeto original (a config é do agente, vale para os outros canais)
    expect(config.splitMessages).toBe(true);
  });

  it("canal sem limite próprio devolve a MESMA config, e config ausente segue ausente", () => {
    const config = { splitMessages: true };
    expect(configDoAgenteNaRede(config, null)).toBe(config);
    expect(configDoAgenteNaRede(null, tiktok)).toBeNull();
  });

  it("os tetos: um texto e até 2 fotos (3 no total); fora da rede, o padrão para os dois", () => {
    expect(tetosDeEnvioDoTurno(tiktok, 5)).toEqual({ maxSendsPerTurn: 3, maxTextosPorTurno: 1 });
    expect(tetosDeEnvioDoTurno(null, 5)).toEqual({ maxSendsPerTurn: 5, maxTextosPorTurno: 5 });
  });
});

