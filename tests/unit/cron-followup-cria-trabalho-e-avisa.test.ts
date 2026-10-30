/**
 * QUEM CRIA TRABALHO AVISA — O CACHE NÃO PODE ESCONDER O QUE A PRÓPRIA ROTA FEZ
 * (#3694).
 *
 * O gate dos crons de minuto lê "o que está ligado" uma vez por janela de 45 s
 * (`lib/cron/recursos-ligados.ts`). Para o que nasce FORA do processo — gatilho
 * no banco, `agent-worker` em outro contêiner — esse atraso é o preço declarado,
 * e o cron de minuto o limita a um tique. Para o que nasce DENTRO da rota, não:
 * a varredura de silêncio inscreve contatos e o próprio tick enfileira
 * `followup_turn` no mesmo request. Sem invalidar, a batida seguinte lê o
 * retrato de ANTES desse trabalho e devolve 200 sem rodar nada.
 *
 * Foi medido no e2e `followup-journey.spec.ts` (parte 5): a inscrição nascia na
 * varredura e os POSTs seguintes — mais rápidos que os 45 s — liam
 * `followup: false` do cache e deixavam o enrollment parado em `trigger-1`.
 * `pollEnrollment timeout esperando "trigger→wait"`, com `claimed_until: null` e
 * `steps_taken: 0`: o claim nunca foi chamado.
 *
 * O par de casos abaixo é o que dá sentido ao conserto:
 *
 *   inscreveu → a batida seguinte RELÊ (2 leituras) e o tick roda;
 *   não inscreveu → a batida seguinte é servida pelo cache (1 leitura) e o tick
 *   não roda — a economia da issue continua de pé.
 *
 * A leitura é a REAL (não mockada) de propósito: o defeito mora no módulo de
 * cache, e um dublê de `recursoLigado` esconderia exatamente ele.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { esquecerLeituraDosRecursos, RECURSOS_DO_CRON } from "@/lib/cron/recursos-ligados";

const estado = vi.hoisted(() => ({
  /** O retrato que o "banco" devolve a `fn_cron_recursos_ligados`. */
  retrato: {} as Record<string, boolean>,
  /** Quantas leituras da função o banco recebeu. */
  leituras: 0,
  /** Quantas inscrições a varredura de silêncio cria nesta batida. */
  enrolled: 0,
  /** Quantas vezes o motor de follow-up rodou. */
  ticks: 0,
}));

const clienteFalso = {
  // `from()` vazio: o que as rotas leem de verdade está mockado abaixo.
  from: () => {
    const passo: Record<string, unknown> = {};
    for (const verbo of ["select", "eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "order", "limit", "update", "delete"]) {
      passo[verbo] = () => passo;
    }
    passo.maybeSingle = async () => ({ data: null, error: null });
    passo.single = async () => ({ data: null, error: null });
    passo.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return passo;
  },
  rpc: (fn: string) => {
    if (fn === "fn_cron_recursos_ligados") {
      estado.leituras += 1;
      return Promise.resolve({ data: { ...estado.retrato }, error: null });
    }
    return Promise.resolve({ data: 0, error: null });
  },
};

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso }));
vi.mock("@/lib/followup/engine", () => ({
  createSupabaseAdminClient: () => ({}) as never,
  runFollowupTick: async () => {
    estado.ticks += 1;
    return { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };
  },
}));
vi.mock("@/lib/followup/agent-followup-gate", () => ({ createSupabaseFollowupGateDb: () => ({}) as never }));
vi.mock("@/lib/followup/silence-sweep", () => ({
  createSupabaseSilenceSweepDb: () => ({}) as never,
  runSilenceSweep: async () => ({
    enrolled: estado.enrolled,
    pointers_gated_out: 0,
    skipped_existing: 0,
    skipped_cooldown: 0,
  }),
}));
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({ enviarTextoFixoPendente: async () => 0 }));
vi.mock("@/lib/followup/atendimento", () => ({ encerrarRoteirosVencidos: async () => 0 }));

import { GET } from "@/app/api/v1/cron/followup-flow-worker/route";

const batida = () =>
  GET(new NextRequest("http://local/api/v1/cron/followup-flow-worker", { headers: { authorization: "Bearer t" } }));

beforeEach(() => {
  esquecerLeituraDosRecursos();
  estado.retrato = Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, false])) as Record<string, boolean>;
  estado.leituras = 0;
  estado.ticks = 0;
  estado.enrolled = 0;
});

describe("followup-flow-worker: o trabalho criado na própria batida é visto na seguinte (#3694)", () => {
  it("varredura inscreveu → a batida seguinte RElÊ os recursos e o motor roda", async () => {
    // Instalação parada: nada vencido, mas há um fluxo ativo esperando silêncio.
    estado.retrato.followup = false;
    estado.retrato.followup_silencio = true;
    estado.enrolled = 1; // a varredura inscreve um contato nesta batida

    await batida();
    expect(estado.ticks).toBe(0); // nada vencido ainda: o gate fez o trabalho dele

    // O banco agora TEM inscrição vencida — a anterior acabou de criar.
    estado.enrolled = 0;
    estado.retrato.followup = true;

    // Segunda batida DENTRO da janela de 45 s (o cenário do e2e: POSTs em
    // rajada). Só roda porque a primeira invalidou a leitura.
    await batida();

    expect(estado.leituras).toBe(2);
    expect(estado.ticks).toBe(1);
  });

  it("sem movimento, a batida seguinte é servida pelo cache — a economia da issue continua de pé", async () => {
    estado.retrato.followup = false; // instalação parada
    estado.retrato.followup_silencio = false;

    await batida();
    await batida(); // 1 s depois, dentro da janela de 45 s

    expect(estado.leituras).toBe(1); // uma ida ao banco para as duas batidas
    expect(estado.ticks).toBe(0); // e nenhum tick — nada a fazer, como antes do #3694
  });
});
