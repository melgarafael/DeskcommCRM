/**
 * FIO: a ligação RECEBIDA que termina sem atendimento publica `voice_call.missed`
 * no `event_log` (#4365).
 *
 * O pedido da comunidade: quem liga para um prestador de serviço que está
 * trabalhando fica sem resposta NEM no telefone. O `event_log` é o único
 * caminho que transforma um fato do produto em gatilho de automação/webhook — e
 * o worker de voz é o único ponto que sabe que a recebida morreu tocando
 * (`handleChannelDestroyed` fecha a linha `ringing` como `timeout`). Sem o
 * evento, a automação "ligação perdida" não tem o que escutar.
 *
 * O dublê aplica os MESMOS filtros que o código manda (`in`/`eq`) e GUARDA o que
 * é inserido em `event_log` — o teste mede o fato publicado, não a chamada da
 * função.
 *
 * CONTROLES (vacuidade não passa):
 *   - ligação ATENDIDA (`connected`) não vira `timeout` e NÃO publica evento;
 *   - ligação FEITA daqui que toca e cai (`direction = outbound`) não é
 *     "perdida": quem discou já sabe, e o evento é só da RECEBIDA.
 *
 * SABOTAGEM DO FIO: tirar a chamada a `publicarLigacaoPerdida` do
 * `handleChannelDestroyed` = o primeiro caso fica vermelho (zero eventos).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const fakes = vi.hoisted(() => ({
  chamadas: [] as Linha[],
  eventos: [] as Linha[],
  roteamento: {
    organization_id: "org-do-fio",
    routing_mode: "ai",
    default_ai_agent_id: null,
    fallback_user_id: null,
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "event_log") {
        return {
          insert: async (linha: Linha) => {
            fakes.eventos.push(linha);
            return { data: null, error: null };
          },
        };
      }
      return {
        insert: (linha: Linha) => {
          const gravada = { id: `chamada-${fakes.chamadas.length + 1}`, ...linha };
          fakes.chamadas.push(gravada);
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
              const alvo = fakes.chamadas.filter((l) => filtros.every((f) => f(l)));
              for (const l of alvo) Object.assign(l, mudanca);
              return { data: alvo[0] ? { ...alvo[0] } : null, error: null };
            },
          };
          return consulta;
        },
      };
    },
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

const CANAL_NATIVO = "1789081888.5";
const TELEFONE_DE_QUEM_LIGA = "27992759009";

beforeEach(() => {
  fakes.chamadas = [];
  fakes.eventos = [];
});

async function recebidaTocando() {
  await handleStasisStart({
    type: "StasisStart",
    channel: {
      id: CANAL_NATIVO,
      dialplan: { exten: "552731912377" },
      caller: { number: TELEFONE_DE_QUEM_LIGA },
    },
  } as never);
}

describe("fio: a ligação recebida sem atendimento vira evento", () => {
  it("o ChannelDestroyed da recebida tocando publica voice_call.missed com contato e número", async () => {
    await recebidaTocando();
    expect(fakes.chamadas).toHaveLength(1);

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

    expect(fakes.chamadas[0]).toMatchObject({ status: "ended", end_reason: "timeout" });
    expect(fakes.eventos).toHaveLength(1);
    expect(fakes.eventos[0]).toMatchObject({
      organization_id: "org-do-fio",
      event_type: "voice_call.missed",
      // O motor hidrata `context.contact` pela linha do evento; sem
      // `entity_kind='contact'` a regra não teria contato nenhum.
      entity_kind: "contact",
      entity_id: "contato-do-fio",
    });
    expect(fakes.eventos[0]!.payload).toMatchObject({
      contact_id: "contato-do-fio",
      call_id: "chamada-1",
      peer_phone: TELEFONE_DE_QUEM_LIGA,
    });
  });

  it("CONTROLE: a recebida ATENDIDA não publica o evento", async () => {
    await recebidaTocando();
    fakes.chamadas[0]!.status = "connected";

    await handleChannelDestroyed({
      type: "ChannelDestroyed",
      channel: { id: CANAL_NATIVO },
    } as never);

    expect(fakes.chamadas[0]).toMatchObject({ status: "connected" });
    expect(fakes.eventos).toHaveLength(0);
  });

  it("CONTROLE: a ligação FEITA que toca e cai não é 'perdida' e não publica", async () => {
    const canalDaFeita = "7aba2d23-3b56-494f-a486-952cb4a0071d";
    fakes.chamadas.push({
      id: "feita",
      organization_id: "org-do-fio",
      direction: "outbound",
      status: "ringing",
      peer_phone: "27999998888",
      contact_id: "contato-da-feita",
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

    expect(fakes.chamadas[0]).toMatchObject({ status: "ended", end_reason: "timeout" });
    expect(fakes.eventos).toHaveLength(0);
  });

  it("chamada que já estava encerrada (recusa pela tela) não publica de novo", async () => {
    await recebidaTocando();
    fakes.chamadas[0]!.status = "ended";
    fakes.chamadas[0]!.end_reason = "declined_by_user";

    await handleChannelDestroyed({
      type: "ChannelDestroyed",
      channel: { id: CANAL_NATIVO },
    } as never);

    expect(fakes.eventos).toHaveLength(0);
  });
});
