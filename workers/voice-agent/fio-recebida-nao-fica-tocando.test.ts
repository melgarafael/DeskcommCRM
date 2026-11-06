/**
 * TESTE DO FIO: ligação RECEBIDA que cai antes do AudioSocket conectar não
 * fica "tocando" para sempre.
 *
 * O caminho medido em produção (2026-11-04): `handleStasisStart` grava a linha
 * `ringing` e devolve o canal ao dialplan; o AudioSocket falha ("Name does not
 * resolve"); o Asterisk destrói o canal e manda `ChannelDestroyed` com o
 * `channel.id` NATIVO. O handler procurava a linha só por esse id, e a linha
 * guardava um UUID sorteado — nunca casava, e a tela mostrava "ligação
 * chegando" a cada carregamento, dias depois.
 *
 * O teste roda os DOIS handlers reais contra uma tabela em memória que aplica
 * os filtros que o código manda (`in`/`eq`), então ele mede a correlação de
 * verdade, não um mock que aceita qualquer coisa.
 *
 * SABOTAGEM DO FIO: trocar `uuidDoAudioSocketDeEntrada(channel.id)` por
 * `randomUUID()` no `handleStasisStart`, OU trocar o
 * `.in("asterisk_channel_id", idsDaLinhaDoCanal(channelId))` por
 * `.eq("asterisk_channel_id", channelId)` no `handleChannelDestroyed` =
 * o caso da recebida fica vermelho (a linha continua `ringing`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const fakes = vi.hoisted(() => ({
  tabela: [] as Array<Record<string, unknown>>,
  roteamento: {
    organization_id: "org-do-fio",
    routing_mode: "ai",
    default_ai_agent_id: null,
    fallback_user_id: null,
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (_tabela: string) => ({
      insert: (linha: Linha) => {
        const gravada = { id: `chamada-${fakes.tabela.length + 1}`, ...linha };
        fakes.tabela.push(gravada);
        const resultado = { data: gravada, error: null };
        return {
          select: () => ({ single: async () => resultado }),
          then: (ok: (r: unknown) => unknown) => Promise.resolve(resultado).then(ok),
        };
      },
      update: (mudanca: Linha) => {
        const filtros: Array<(l: Linha) => boolean> = [];
        const consulta = {
          in: (col: string, valores: unknown[]) => {
            filtros.push((l) => valores.includes(l[col]));
            return consulta;
          },
          eq: (col: string, valor: unknown) => {
            filtros.push((l) => l[col] === valor);
            return consulta;
          },
          select: () => consulta,
          maybeSingle: async () => {
            const alvo = fakes.tabela.filter((l) => filtros.every((f) => f(l)));
            for (const l of alvo) Object.assign(l, mudanca);
            return { data: alvo[0] ? { id: alvo[0].id } : null, error: null };
          },
        };
        return consulta;
      },
    }),
    rpc: () => ({ single: async () => ({ data: fakes.roteamento, error: null }) }),
  }),
}));

vi.mock("@/lib/voip/ariClient", () => ({
  connectAriEvents: () => undefined,
  hangupChannel: async () => undefined,
  setChannelVariable: async () => undefined,
  continueDialplan: async () => undefined,
}));

vi.mock("@/lib/voip/resolve-caller", () => ({
  resolveOrCreateCallerContact: async () => ({ id: "contato-do-fio", is_blocked: false }),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: async () => ({ criado: false, motivo: "ja_existe" }),
}));
vi.mock("@/lib/ai/agents", () => ({ getActiveVoiceAgent: async () => null }));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));

import { handleChannelDestroyed, handleStasisStart } from "./index";

/** O formato que o Asterisk usa de verdade no `channel.id` da entrada. */
const CANAL_NATIVO = "1789081888.5";

beforeEach(() => {
  fakes.tabela = [];
});

describe("fio: a recebida que cai antes da IA não fica tocando", () => {
  it("o ChannelDestroyed do canal nativo encerra a linha que o StasisStart gravou", async () => {
    await handleStasisStart({
      type: "StasisStart",
      channel: {
        id: CANAL_NATIVO,
        dialplan: { exten: "552731912377" },
        caller: { number: "27992759009" },
      },
    } as never);
    expect(fakes.tabela).toHaveLength(1);
    expect(fakes.tabela[0]).toMatchObject({ direction: "inbound", status: "ringing" });

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await handleChannelDestroyed({
        type: "ChannelDestroyed",
        channel: { id: CANAL_NATIVO },
        cause_txt: "Normal Clearing",
      } as never);
    } finally {
      info.mockRestore();
    }

    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "timeout" });
    expect(typeof fakes.tabela[0]!.ended_at).toBe("string");
  });

  it("a feita (o id do canal É o asterisk_channel_id) continua sendo encerrada", async () => {
    const canalDaFeita = "7aba2d23-3b56-494f-a486-952cb4a0071d";
    fakes.tabela.push({
      id: "feita",
      direction: "outbound",
      status: "ringing",
      asterisk_channel_id: canalDaFeita,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await handleChannelDestroyed({
        type: "ChannelDestroyed",
        channel: { id: canalDaFeita },
      } as never);
    } finally {
      info.mockRestore();
    }
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "timeout" });
  });

  it("a recebida que a IA atendeu (connected) não vira 'timeout' quando o canal some", async () => {
    await handleStasisStart({
      type: "StasisStart",
      channel: {
        id: CANAL_NATIVO,
        dialplan: { exten: "552731912377" },
        caller: { number: "27992759009" },
      },
    } as never);
    fakes.tabela[0]!.status = "connected";
    await handleChannelDestroyed({
      type: "ChannelDestroyed",
      channel: { id: CANAL_NATIVO },
    } as never);
    expect(fakes.tabela[0]).toMatchObject({ status: "connected" });
    expect(fakes.tabela[0]!.end_reason).toBeUndefined();
  });

  it("o canal de OUTRA ligação não encerra esta", async () => {
    await handleStasisStart({
      type: "StasisStart",
      channel: {
        id: CANAL_NATIVO,
        dialplan: { exten: "552731912377" },
        caller: { number: "27992759009" },
      },
    } as never);
    await handleChannelDestroyed({
      type: "ChannelDestroyed",
      channel: { id: "1789081888.6" },
    } as never);
    expect(fakes.tabela[0]).toMatchObject({ status: "ringing" });
  });
});
