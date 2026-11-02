/**
 * CADA ROTA DE MINUTO SAI CEDO QUANDO O RECURSO ESTÁ DESLIGADO (#3694) — e
 * volta a rodar assim que ele liga.
 *
 * Um caso por rota, dois lados cada:
 *
 *   desligado → ZERO consulta ao PostgREST (é o defeito da issue: seis
 *               consultas por minuto, todas vazias);
 *   ligado    → a rodada de verdade roda (o gate não pode calar quem tem
 *               trabalho — esse é o erro que seria pior que a consulta vazia).
 *
 * O gate em si é mockado aqui: o que se mede é a decisão da ROTA. O relógio, o
 * cache e a invalidação estão em `cron-recursos-ligados.test.ts`.
 *
 * `campaign-worker` e `historico-import` NÃO estão aqui: os dois ficaram com o
 * piso ocioso do #3731, que já cobria esses recursos quando este ramo foi
 * mesclado com a main. Quem mede essas duas rotas é
 * `tests/unit/piso-ocioso-dos-crons.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as RecursosLigadosMod from "@/lib/cron/recursos-ligados";

const estado = vi.hoisted(() => ({
  ligado: {} as Record<string, boolean>,
  /** Toda tabela tocada por `from()` — a prova de "não tocou o PostgREST". */
  consultas: {} as Record<string, number>,
  rpcs: [] as string[],
  rodada: 0,
}));

function cadeia(tabela: string): Record<string, unknown> {
  estado.consultas[tabela] = (estado.consultas[tabela] ?? 0) + 1;
  const resposta = { data: [], error: null };
  const passo: Record<string, unknown> = {};
  for (const verbo of ["select", "eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "order", "limit", "update", "delete"]) {
    passo[verbo] = () => cadeia(tabela);
  }
  passo.maybeSingle = async () => ({ data: null, error: null });
  passo.single = async () => ({ data: null, error: null });
  passo.insert = async () => ({ data: null, error: null });
  passo.upsert = async () => ({ data: null, error: null });
  // Cadeia "aguardável": qualquer `await` sobre ela resolve com o vazio.
  passo.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resposta).then(resolve);
  return passo;
}

const clienteFalso = {
  from: (tabela: string) => cadeia(tabela),
  rpc: (fn: string) => {
    estado.rpcs.push(fn);
    return Promise.resolve({ data: 0, error: null });
  },
};

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso }));
vi.mock("@/lib/cron/recursos-ligados", async () => {
  const real = await vi.importActual<typeof RecursosLigadosMod>("@/lib/cron/recursos-ligados");
  return {
    ...real,
    recursoLigado: async (_db: unknown, recurso: string) => estado.ligado[recurso] !== false,
  };
});
vi.mock("@/lib/campanhas/rodada", () => ({
  rodarUmaRodadaDeCampanha: async () => {
    estado.rodada += 1;
    return { enviadas: 0, pulados: 0, concluidas: 0, promovidas: 0, detalhe: "nada_a_fazer" };
  },
}));
vi.mock("@/lib/channels/reprocessar-arquivo-de-webhook", () => ({
  reprocessarArquivoDeWebhooks: async () => {
    estado.rodada += 1;
    return { lidas: 0, processadas: 0, ainda_falhando: 0, desistidas: 0 };
  },
}));
vi.mock("@/lib/followup/engine", () => ({
  createSupabaseAdminClient: () => ({}) as never,
  runFollowupTick: async () => {
    estado.rodada += 1;
    return { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
  },
}));
vi.mock("@/lib/followup/agent-followup-gate", () => ({ createSupabaseFollowupGateDb: () => ({}) as never }));
vi.mock("@/lib/followup/silence-sweep", () => ({
  createSupabaseSilenceSweepDb: () => ({}) as never,
  runSilenceSweep: async () => {
    estado.rodada += 1;
    return { enrolled: 0, pointers_gated_out: 0, skipped_existing: 0, skipped_cooldown: 0 };
  },
}));
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({
  enviarTextoFixoPendente: async () => {
    estado.rodada += 1;
  },
}));
vi.mock("@/lib/followup/atendimento", () => ({ encerrarRoteirosVencidos: async () => 0 }));
vi.mock("@/lib/channels/aviso-do-agendador", () => ({ sincronizarAvisoDoAgendador: async () => undefined }));
vi.mock("@/lib/channels/central-de-pausa", () => ({ sincronizarAvisoDePausa: async () => undefined }));

import { GET as webhookReplay } from "@/app/api/v1/cron/webhook-replay/route";
import { GET as followupFlowWorker } from "@/app/api/v1/cron/followup-flow-worker/route";
import { GET as channelPauseScheduler } from "@/app/api/v1/cron/channel-pause-scheduler/route";
import { GET as propostaTravada } from "@/app/api/v1/cron/proposta-travada/route";

type Rota = (req: NextRequest) => Promise<Response>;

function chamar(rota: Rota, caminho: string): Promise<Response> {
  return rota(new NextRequest(`http://local/api/v1/cron/${caminho}`, { headers: { authorization: "Bearer teste" } }));
}

const dadosDe = async (res: Response) => ((await res.json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  estado.ligado = {};
  estado.consultas = {};
  estado.rpcs = [];
  estado.rodada = 0;
});

describe("webhook-replay", () => {
  it("desligado: sai cedo, sem NENHUM from() ao PostgREST", async () => {
    estado.ligado.webhook_replay = false;
    const dados = await dadosDe(await chamar(webhookReplay, "webhook-replay"));

    expect(dados).toMatchObject({ lidas: 0, pulado: "recurso_desligado" });
    expect(estado.rodada).toBe(0);
    expect(estado.consultas).toEqual({});
  });

  it("ligado: o replay roda", async () => {
    estado.ligado.webhook_replay = true;
    await chamar(webhookReplay, "webhook-replay");
    expect(estado.rodada).toBe(1);
  });
});

describe("followup-flow-worker", () => {
  it("os três recursos desligados: nenhuma das três rodadas e nenhum from()", async () => {
    estado.ligado = { followup: false, followup_silencio: false, fila_followup: false };
    const dados = await dadosDe(await chamar(followupFlowWorker, "followup-flow-worker"));

    expect(dados).toMatchObject({
      claimed: 0,
      recursos: { followup: false, followup_silencio: false, fila_followup: false },
    });
    expect(estado.rodada).toBe(0);
    // A varredura de confirmação de presença continua rodando: é mutação de
    // agenda e ficou DE FORA do gate de propósito (ver o comentário da rota).
    expect(estado.consultas).toEqual({});
    expect(estado.rpcs).toEqual(["fn_appointment_confirmation_sweep"]);
  });

  it("só o follow-up ligado: o tick roda e o silêncio/dreno não", async () => {
    estado.ligado = { followup: true, followup_silencio: false, fila_followup: false };
    const dados = await dadosDe(await chamar(followupFlowWorker, "followup-flow-worker"));

    expect(dados).toMatchObject({ recursos: { followup: true, followup_silencio: false, fila_followup: false } });
    expect(estado.rodada).toBe(1);
  });
});

describe("channel-pause-scheduler", () => {
  it("desligado: sai cedo, sem NENHUM from() ao PostgREST", async () => {
    estado.ligado.pausa_de_canal = false;
    const dados = await dadosDe(await chamar(channelPauseScheduler, "channel-pause-scheduler"));

    expect(dados).toMatchObject({ avaliadas: 0, pulado: "recurso_desligado" });
    expect(estado.consultas).toEqual({});
  });

  it("ligado: a batida lê as janelas de verdade", async () => {
    estado.ligado.pausa_de_canal = true;
    await chamar(channelPauseScheduler, "channel-pause-scheduler");
    expect(estado.consultas.channel_schedules).toBeGreaterThan(0);
  });
});

describe("proposta-travada", () => {
  it("desligado: sai cedo, sem NENHUM from() ao PostgREST", async () => {
    estado.ligado.propostas = false;
    const dados = await dadosDe(await chamar(propostaTravada, "proposta-travada"));

    expect(dados).toMatchObject({ scanned: 0, pulado: "recurso_desligado" });
    expect(estado.consultas).toEqual({});
  });

  it("ligado: varre as propostas em `enviando`", async () => {
    estado.ligado.propostas = true;
    await chamar(propostaTravada, "proposta-travada");
    expect(estado.consultas.crm_proposals).toBeGreaterThan(0);
  });
});
