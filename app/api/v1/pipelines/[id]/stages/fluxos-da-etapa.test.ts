/**
 * #3603 — «quais fluxos disparam quando o negócio ENTRA nesta etapa?»
 *
 * O gatilho por etapa já existe e já arma (`trigger_config.kind='stage_change'`,
 * `lib/followup/gatilho-etapa.ts`), mas nenhuma leitura devolvia essa relação: o
 * gestor configurava o fluxo no editor e, na tela do funil, via uma etapa igual
 * às outras — sem nada dizendo que entrar ali dispara uma sequência de toques.
 * Quem suspeitava de mensagem automática não tinha onde conferir.
 *
 * Este arquivo mede a LEITURA. O motor do follow-up não é tocado: nada aqui
 * escreve, e as portas são as MESMAS que o motor usa para armar
 * (`etapaQueOPointerArma`, nó de gatilho, gate do agente), para a tela nunca
 * prometer um fluxo que não sairia. O barrado só pela falta de agente aparece,
 * marcado com `sem_agente`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  authOk,
  etapa,
  grafoDeFluxo,
  makeDb,
} from "@/tests/helpers/stages-db-double";

const ctx = { params: Promise.resolve({ id: PIPE }) };

/** Duas etapas do funil — ids UUID porque o `stage_id` do gatilho é `z.string().uuid()`. */
const ETAPA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Etapa de OUTRO funil: existe no banco e não pode casar com nenhuma das duas. */
const ETAPA_DE_OUTRO_FUNIL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FLUXO_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const VERSAO_A = "99999999-9999-4999-8999-999999999999";

const etapas = () => [
  etapa({ id: ETAPA_A, name: "Proposta", position: 1000 }),
  etapa({ id: ETAPA_B, name: "Pago", position: 2000, is_won: true }),
];

/** Um pointer como o banco o guarda. `over` deixa o teste mentir só o campo em pauta. */
function pointer(over: Record<string, unknown> = {}) {
  return {
    id: FLUXO_A,
    organization_id: ORG_ID,
    name: "Retomada da proposta",
    status: "active",
    active_version_id: VERSAO_A,
    trigger_config: { kind: "stage_change", params: { stage_id: ETAPA_A } },
    ...over,
  };
}

/** A versão ativa do fluxo — por padrão só texto fixo, com nó de gatilho. */
function versao(graph: unknown = grafoDeFluxo()) {
  return { id: VERSAO_A, organization_id: ORG_ID, graph };
}

/** Agente com a versão PUBLICADA e o follow-up ligado armando estes fluxos. */
function agente(pointerIds: string[], over: Record<string, unknown> = {}) {
  return {
    agent_id: "aaaa0000-0000-4000-8000-000000000001",
    organization_id: ORG_ID,
    status: "published",
    followup: { enabled: true, flow_pointer_ids: pointerIds },
    ...over,
  };
}

/** O banco do teste com a versão ativa já presente — o caso de todo teste que não é sobre ela. */
const db = (opts: Parameters<typeof makeDb>[0]) => makeDb({ flowVersions: [versao()], ...opts });

async function get() {
  const { GET } = await import("./route");
  const req = new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages`, {
    method: "GET",
  });
  return GET(req, ctx);
}

type EtapaLida = {
  id: string;
  name: string;
  fluxos?: Array<{ id: string; name: string; sem_agente: boolean }>;
};

async function etapasDaLinhaDeResposta(): Promise<Record<string, EtapaLida>> {
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: EtapaLida[] };
  return Object.fromEntries(body.data.map((e) => [e.id, e]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/stages — fluxos armados por etapa (#3603)", () => {
  /**
   * ⭐ O TESTE DA FATIA. Antes desta entrega o corpo da etapa não tinha campo
   * nenhum sobre fluxo: `fluxos` vinha `undefined` e a tela não tinha como
   * dizer que entrar em «Proposta» dispara um follow-up.
   */
  it("devolve o fluxo armado na etapa A — e lista vazia na etapa B", async () => {
    authOk();
    db({ stages: etapas(), pointers: [pointer()] });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([
      { id: FLUXO_A, name: "Retomada da proposta", sem_agente: false },
    ]);
    // A etapa sem fluxo devolve LISTA VAZIA, não `undefined`: a tela não pode
    // distinguir «não carregou» de «não tem nenhum» — as duas rendem a mesma
    // frase, e uma delas é mentira.
    expect(porId[ETAPA_B]?.fluxos).toEqual([]);
  });

  /**
   * RECORTE DECLARADO: só o fluxo ATIVO (publicado) aparece.
   *
   * É o mesmo recorte do motor (`carregaPointersDeEtapa`): `status='active'` com
   * `active_version_id`. Um rascunho não dispara nada, e listá-lo faria o gestor
   * procurar mensagem que nunca saiu; o desativado é o oposto — já disparou um
   * dia e hoje não dispara mais.
   */
  it("rascunho e desativado NÃO aparecem; o ativo da mesma etapa aparece", async () => {
    authOk();
    db({
      stages: etapas(),
      pointers: [
        pointer({ id: "22222222-aaaa-4aaa-8aaa-222222222222", name: "Rascunho", status: "draft" }),
        pointer({
          id: "33333333-aaaa-4aaa-8aaa-333333333333",
          name: "Desligado",
          status: "disabled",
        }),
        // Ativo mas SEM versão publicada: o motor também o ignora
        // (`active_version_id` nulo não arma nada), então ele não entra.
        pointer({
          id: "44444444-aaaa-4aaa-8aaa-444444444444",
          name: "Ativo sem versão",
          active_version_id: null,
        }),
        pointer(),
      ],
    });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([
      { id: FLUXO_A, name: "Retomada da proposta", sem_agente: false },
    ]);
  });

  /** Gatilho de outro tipo na MESMA etapa não vira linha: não é fluxo de etapa. */
  it("fluxo com gatilho manual/silêncio não aparece", async () => {
    authOk();
    db({
      stages: etapas(),
      pointers: [
        pointer({
          id: "55555555-aaaa-4aaa-8aaa-555555555555",
          name: "Manual",
          trigger_config: { kind: "manual" },
        }),
        pointer({
          id: "66666666-aaaa-4aaa-8aaa-666666666666",
          name: "Silêncio",
          trigger_config: { kind: "silence", params: { hours: 24 } },
        }),
      ],
    });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([]);
    expect(porId[ETAPA_B]?.fluxos).toEqual([]);
  });

  /**
   * ISOLAMENTO, as duas portas que existem:
   *   - outra ORGANIZAÇÃO (a consulta é filtrada por `organization_id`);
   *   - outra ETAPA, de outro funil da mesma organização (a ligação é o
   *     `stage_id` do gatilho, e ele não casa com nenhuma etapa desta resposta).
   *
   * O pointer da outra org aponta para a MESMA etapa A de propósito: se o filtro
   * de tenant cair, ele aparece nesta resposta e o teste reprova por conteúdo,
   * não por status.
   */
  it("fluxo de outra organização e fluxo armado em etapa de outro funil não aparecem", async () => {
    authOk();
    db({
      stages: etapas(),
      pointers: [
        pointer({
          id: "77777777-aaaa-4aaa-8aaa-777777777777",
          name: "Fluxo de outra empresa",
          organization_id: OUTRA_ORG,
        }),
        pointer({
          id: "88888888-aaaa-4aaa-8aaa-888888888888",
          name: "Fluxo de outro funil",
          trigger_config: { kind: "stage_change", params: { stage_id: ETAPA_DE_OUTRO_FUNIL } },
        }),
      ],
    });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([]);
    expect(porId[ETAPA_B]?.fluxos).toEqual([]);
  });

  /**
   * SEM N+1: a lista de fluxos é UMA consulta por requisição, não uma por etapa.
   * Com quatro etapas no funil, um laço por etapa faria quatro leituras — e numa
   * tela de configuração com funil de vinte colunas isso vira vinte idas ao
   * banco por render.
   */
  it("custa UMA leitura de pointers para o funil inteiro", async () => {
    authOk();
    const banco = db({
      stages: [
        ...etapas(),
        etapa({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Negociação", position: 1500 }),
        etapa({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "Cancelado", position: 3000 }),
      ],
      pointers: [
        pointer(),
        pointer({ id: "12121212-aaaa-4aaa-8aaa-121212121212", name: "Segundo toque" }),
        pointer({
          id: "13131313-aaaa-4aaa-8aaa-131313131313",
          name: "Terceiro toque",
          trigger_config: { kind: "stage_change", params: { stage_id: ETAPA_B } },
        }),
      ],
    });

    await etapasDaLinhaDeResposta();

    expect(banco.leituras.filter((t) => t === "followup_flow_pointers")).toHaveLength(1);
    // As outras duas portas do motor custam UMA leitura cada, nunca uma por fluxo.
    expect(banco.leituras.filter((t) => t === "followup_flow_versions")).toHaveLength(1);
    expect(banco.leituras.filter((t) => t === "ai_agent_versions")).toHaveLength(1);
  });

  /**
   * As outras portas do motor que não dependem do negócio. Cada caso é um fluxo
   * ativo, publicado e apontado para a etapa A — o que a versão anterior desta
   * leitura listava — e que o motor NÃO dispara (ou dispara só com agente).
   */
  it("roteiro de atendimento não aparece", async () => {
    authOk();
    db({ stages: etapas(), pointers: [pointer({ surface: "atendimento" })] });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([]);
  });

  it("versão ativa sem nó de gatilho não aparece", async () => {
    authOk();
    makeDb({
      stages: etapas(),
      pointers: [pointer()],
      flowVersions: [versao(grafoDeFluxo({ gatilho: false }))],
    });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([]);
  });

  it("pede IA e nenhum agente com follow-up ligado o arma: aparece MARCADO", async () => {
    authOk();
    makeDb({
      stages: etapas(),
      pointers: [pointer()],
      flowVersions: [versao(grafoDeFluxo({ pedeIA: true }))],
      // Agente que tem o fluxo na lista mas com o follow-up DESLIGADO não arma,
      // e agente com o follow-up ligado mas só em rascunho também não.
      agentVersions: [
        agente([FLUXO_A], { followup: { enabled: false, flow_pointer_ids: [FLUXO_A] } }),
        agente([FLUXO_A], { agent_id: "aaaa0000-0000-4000-8000-000000000002", status: "draft" }),
      ],
    });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([
      { id: FLUXO_A, name: "Retomada da proposta", sem_agente: true },
    ]);
  });

  it("pede IA e um agente publicado com follow-up ligado o arma: aparece sem marca", async () => {
    authOk();
    makeDb({
      stages: etapas(),
      pointers: [pointer()],
      flowVersions: [versao(grafoDeFluxo({ pedeIA: true }))],
      agentVersions: [agente([FLUXO_A])],
    });

    const porId = await etapasDaLinhaDeResposta();

    expect(porId[ETAPA_A]?.fluxos).toEqual([
      { id: FLUXO_A, name: "Retomada da proposta", sem_agente: false },
    ]);
  });

  /** FRONTEIRA: a leitura não escreve nada e não fala com o motor de follow-up. */
  it("não escreve nenhuma linha", async () => {
    authOk();
    const banco = db({ stages: etapas(), pointers: [pointer()] });

    await etapasDaLinhaDeResposta();

    expect(banco.escritas).toEqual([]);
    expect(banco.rpcs).toEqual([]);
  });
});
