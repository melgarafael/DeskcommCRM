/**
 * O GATILHO `lead.tag_added` COM O NEGÓCIO EM OUTRO FUNIL: A REGRA TRANSFERE (#2155).
 *
 * ═══ O defeito, medido na instalação real da issue ═══
 *
 * Três funis (Recepção = entrada, e os de produto), um agente por funil e um
 * roteador no número. A regra "Recepção → Funil X", de gatilho `lead.tag_added`
 * e ação `create_or_move_lead`, deveria levar o card ao funil do produto — e as
 * duas regras ficavam com `run_count = 0`.
 *
 * O motivo é um galho da própria ação: quando o evento TRAZ o negócio
 * (`context.lead`), `create_or_move_lead` compara `lead.pipeline_id` com o
 * funil da regra e devolve `failed / cross_pipeline_move_not_allowed` antes de
 * qualquer coisa (lib/automation/actions/create-or-move-lead.ts, ramo `if
 * (lead)`). O caminho que TRANSFERE — `transfereParaOFunil`, o mesmo da rota
 * `/clone` — só é alcançável pelo ramo POR CONTATO, que é justamente o ramo que
 * roda quando o evento NÃO traz o negócio. O desenho "a Recepção etiqueta, a
 * regra transfere" ficava sem saída no único caso em que ele existe.
 *
 * ═══ O que este arquivo vigia ═══
 *
 * A nova regra, e o escopo estreito dela: COM o negócio no evento, gatilho
 * `lead.tag_added` e funil de destino diferente, a ação TRANSFERE — clona para
 * o funil da regra (`montaPayloadDoClone`) e encerra a origem como perdida com
 * o motivo da transferência —; e o CLONE é o negócio que as ações seguintes da
 * mesma regra enxergam (`publicaNoContexto`).
 *
 * Dois controles prendem que nada ao redem mudou: negócio já no funil da regra
 * continua sendo movido de etapa (a operação comum de um funil só), e evento
 * SEM negócio continua caindo no ramo de contato de sempre. Um terceiro
 * controla o ESCOPO declarado: qualquer outro gatilho que traga o negócio
 * (`lead.stage_changed`, `lead.created`, …) segue recusando, porque a proposta
 * principal da #2155 — `pipeline_id`/`stage_id` em `ai_router_members` —
 * exige migration e não entra aqui.
 */
import { describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  createLeadHandler: vi.fn(),
  moveLeadHandler: vi.fn(),
  encerraDemanda: vi.fn(),
}));

vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: (...args: unknown[]) => spies.createLeadHandler(...args),
  moveLeadHandler: (...args: unknown[]) => spies.moveLeadHandler(...args),
}));

vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: (...args: unknown[]) => spies.encerraDemanda(...args),
}));

vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: async () => null,
}));

import { getAction } from "@/lib/automation/actions";
import { MOTIVO_PADRAO_DA_TROCA } from "@/lib/leads/motivo-da-perda";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";

import "@/lib/automation/actions/create-or-move-lead";

const MOTIVO_DA_TRANSFERENCIA = "moved_to_another_pipeline";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "c0c0c0c0-0000-0000-0000-000000000001";
/** O funil de ENTRADA — onde o card nasce e onde a condição da regra o acha. */
const FUNIL_A = "f0f0f0f0-0000-0000-0000-00000000000a";
/** O funil de DESTINO — o que a regra `lead.tag_added` aponta. */
const FUNIL_B = "f0f0f0f0-0000-0000-0000-00000000000b";
const ETAPA_DO_FUNIL_A = "e0e0e0e0-0000-0000-0000-00000000000a";
const ETAPA_INICIAL_DO_B = "e0e0e0e0-0000-0000-0000-0000000000b1";
const ETAPA_ESCOLHIDA = "e0e0e0e0-0000-0000-0000-0000000000b2";
const ETAPA_DE_PERDA_DO_A = "e0e0e0e0-0000-0000-0000-000000000ff";

const TITULO_DA_ORIGEM = "Aporte mensal em ações";

/** A linha COMPLETA de `crm_leads` — é o que `buildContext` põe em `context.lead`. */
const NEGOCIO_NO_FUNIL_A = {
  id: "1ea1-0000-0000-0000-000000000001",
  pipeline_id: FUNIL_A,
  stage_id: ETAPA_DO_FUNIL_A,
  status: "open",
  title: TITULO_DA_ORIGEM,
  description: "Cliente pediu simulação",
  contact_id: CONTATO,
  value_cents: 150000,
  currency: "BRL",
  owner_user_id: null,
  owner_agent_id: null,
  expected_close_date: null,
  tags: ["intencao-b"],
  source: "whatsapp",
  custom_fields: { canal: "rotativo" },
  source_metadata: {},
};

const ETAPAS_DO_FUNIL_B = [
  {
    id: ETAPA_INICIAL_DO_B,
    pipeline_id: FUNIL_B,
    position: 1,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
  {
    id: ETAPA_ESCOLHIDA,
    pipeline_id: FUNIL_B,
    position: 2,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
];

/** O suficiente do client admin para as leituras que a ação faz. */
function adminFalso(cenarios: {
  negocioNoFunilDaRegra?: unknown;
  negocioEmOutroFunil?: unknown;
  etapasDoDestino?: unknown;
  etapaDePerda?: unknown;
}) {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const api: Record<string, unknown> = {};
      const mesmo = () => api;
      api.select = mesmo;
      api.order = mesmo;
      api.limit = mesmo;
      api.eq = (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        return api;
      };
      api.neq = (coluna: string, valor: unknown) => {
        filtros[`neq:${coluna}`] = valor;
        return api;
      };
      const resposta = () => {
        if (tabela === "crm_leads") {
          if (filtros["neq:pipeline_id"]) return cenarios.negocioEmOutroFunil ?? null;
          return cenarios.negocioNoFunilDaRegra ?? null;
        }
        if (tabela === "crm_stages") {
          if (filtros.is_lost === true) return cenarios.etapaDePerda ?? null;
          return cenarios.etapasDoDestino ?? null;
        }
        return null;
      };
      const terminal = async () => ({ data: resposta(), error: null });
      api.maybeSingle = terminal;
      api.single = terminal;
      api.then = (resolver: (valor: unknown) => unknown) => terminal().then(resolver);
      return api;
    },
  };
}

/** O evento que o motor entrega — `lead.tag_added` é de negócio (`crm_lead`). */
function evento(tipo: string): EventRow {
  return {
    id: "7e7e7e7e-0000-0000-0000-000000000001",
    organization_id: ORG,
    event_type: tipo,
    entity_kind: "crm_lead",
    entity_id: NEGOCIO_NO_FUNIL_A.id,
    payload: { tag: "intencao-b" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  } as EventRow;
}

function contexto(
  cenarios: Parameters<typeof adminFalso>[0] = {},
  opcoes: { tipoDoEvento?: string; comNegocio?: boolean } = {},
): ActionCtx {
  const context: Record<string, unknown> = {
    contact: { id: CONTATO, name: "Helena Barros", phone_number: "+551****0001" },
  };
  if (opcoes.comNegocio !== false) context.lead = NEGOCIO_NO_FUNIL_A;
  return {
    admin: adminFalso(cenarios),
    organizationId: ORG,
    ruleId: "r0r0r0r0-0000-0000-0000-000000000001",
    ruleName: "Recepção → Funil B",
    event: evento(opcoes.tipoDoEvento ?? "lead.tag_added"),
    context,
    requestId: "rule:r0r0r0r0-0000-0000-0000-000000000001",
  } as unknown as ActionCtx;
}

const CONFIG = { pipeline_id: FUNIL_B, stage_id: ETAPA_ESCOLHIDA };

const CENARIOS_DA_TRANSFERENCIA = {
  etapasDoDestino: ETAPAS_DO_FUNIL_B,
  etapaDePerda: { id: ETAPA_DE_PERDA_DO_A },
};

/** O TERCEIRO argumento de uma chamada (admin, ctx, payload) — sem `[0][2]` solto. */
function argumentoDaChamada(
  spy: { mock: { calls: unknown[][] } },
  indice = 0,
): Record<string, unknown> {
  const chamada = spy.mock.calls[indice];
  expect(chamada).toBeDefined();
  return (chamada as unknown[])[2] as Record<string, unknown>;
}

function limpaOsSpies(): void {
  spies.createLeadHandler.mockReset();
  spies.moveLeadHandler.mockReset();
  spies.encerraDemanda.mockReset();
}

describe("create_or_move_lead — o gatilho lead.tag_added transfere o negócio de funil", () => {
  it("O DEFEITO (#2155): negócio no funil A + gatilho lead.tag_added transfere para o funil B", async () => {
    limpaOsSpies();
    spies.createLeadHandler.mockResolvedValue({
      id: "clone-tag-0001",
      pipeline_id: FUNIL_B,
      stage_id: ETAPA_ESCOLHIDA,
      contact_id: CONTATO,
    });
    spies.encerraDemanda.mockResolvedValue({ lead: { id: NEGOCIO_NO_FUNIL_A.id } });

    const ctx = contexto(CENARIOS_DA_TRANSFERENCIA);
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");

    // O negócio do funil B nasce com o conteúdo do de A — não é um card em branco.
    expect(spies.createLeadHandler).toHaveBeenCalledTimes(1);
    const payload = argumentoDaChamada(spies.createLeadHandler);
    expect(payload.pipeline_id).toBe(FUNIL_B);
    expect(payload.stage_id).toBe(ETAPA_ESCOLHIDA);
    expect(payload.title).toBe(TITULO_DA_ORIGEM);
    expect(payload.contact_id).toBe(CONTATO);
    expect(payload.value_cents).toBe(150000);
    expect(payload.custom_fields).toEqual({ canal: "rotativo" });
    expect(payload.source_metadata).toMatchObject({
      clonado_de: { lead_id: NEGOCIO_NO_FUNIL_A.id, pipeline_id: FUNIL_A },
    });

    // O do funil A encerra como PERDIDA, com o motivo da transferência.
    expect(spies.encerraDemanda).toHaveBeenCalledTimes(1);
    const encerramento = argumentoDaChamada(spies.encerraDemanda);
    expect(encerramento.leadId).toBe(NEGOCIO_NO_FUNIL_A.id);
    expect(encerramento.desfecho).toBe("lost");
    expect(encerramento.motivo).toBe(MOTIVO_DA_TRANSFERENCIA);
    expect(encerramento.razaoNaTimeline).toBe("Levado para outro funil pela automação");
    expect(encerramento.payloadNaTimeline).toMatchObject({ to_pipeline_id: FUNIL_B });

    // E o CLONE é o negócio que as próximas ações da regra enxergam.
    const publicado = (ctx.context.lead ?? {}) as Record<string, unknown>;
    expect(publicado.id).toBe("clone-tag-0001");
    expect(publicado.pipeline_id).toBe(FUNIL_B);

    // Nada de "mover de etapa": mover entre funis é recusado, transferir é o caminho.
    expect(spies.moveLeadHandler).not.toHaveBeenCalled();
    expect(resultado.error).toBeUndefined();
    expect(resultado.detail).toMatchObject({ origem: NEGOCIO_NO_FUNIL_A.id });
  });

  it("CONTROLE: negócio já no funil da regra continua sendo movido de etapa — igual a hoje", async () => {
    limpaOsSpies();
    spies.moveLeadHandler.mockResolvedValue({ id: NEGOCIO_NO_FUNIL_A.id, pipeline_id: FUNIL_B });

    const ctx = contexto({
      ...CENARIOS_DA_TRANSFERENCIA,
      negocioNoFunilDaRegra: { id: NEGOCIO_NO_FUNIL_A.id },
    });
    // O MESMO lead, só que já morando no funil B.
    ctx.context.lead = { ...NEGOCIO_NO_FUNIL_A, pipeline_id: FUNIL_B };
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
  });

  it("CONTROLE: sem negócio no evento, o comportamento de hoje não muda — cria", async () => {
    limpaOsSpies();
    spies.createLeadHandler.mockResolvedValue({ id: "novo-tag-0001", contact_id: CONTATO });

    const ctx = contexto({ ...CENARIOS_DA_TRANSFERENCIA, etapaDePerda: null }, { comNegocio: false });
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.createLeadHandler).toHaveBeenCalledTimes(1);
    const payload = argumentoDaChamada(spies.createLeadHandler);
    expect(payload.pipeline_id).toBe(FUNIL_B);
    expect(payload.source).toBe("automation");
    expect(payload.title).toBe("Helena Barros");
    expect(payload.source_metadata).toBeUndefined();
    expect(spies.moveLeadHandler).not.toHaveBeenCalled();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
  });

  it("CONTROLE: outro gatilho com o negócio em outro funil segue recusando (escopo da #2155)", async () => {
    limpaOsSpies();
    spies.createLeadHandler.mockResolvedValue({ id: "clone-fora-de-escopo" });

    const ctx = contexto(CENARIOS_DA_TRANSFERENCIA, { tipoDoEvento: "lead.stage_changed" });
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("failed");
    expect(resultado.error).toBe("cross_pipeline_move_not_allowed");
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
    expect(spies.moveLeadHandler).not.toHaveBeenCalled();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
  });

  it("UMA transferência por evento: a 2ª regra no MESMO contexto não leva o clone de volta (A→B→A)", async () => {
    // O motor passa o MESMO `context` a todas as regras aplicáveis de um evento
    // (`engine.ts`), e a 1ª transferência publica o clone nele. Duas regras
    // `lead.tag_added` opostas casando juntas = duas execuções sobre este ctx.
    limpaOsSpies();
    spies.createLeadHandler.mockResolvedValue({
      id: "clone-tag-0001",
      pipeline_id: FUNIL_B,
      stage_id: ETAPA_ESCOLHIDA,
      contact_id: CONTATO,
    });
    spies.encerraDemanda.mockResolvedValue({ lead: { id: NEGOCIO_NO_FUNIL_A.id } });

    const etapaAbertaDoA = {
      id: ETAPA_DO_FUNIL_A,
      pipeline_id: FUNIL_A,
      position: 1,
      is_won: false,
      is_lost: false,
      is_archived: false,
    };
    const ctx = contexto({
      ...CENARIOS_DA_TRANSFERENCIA,
      etapasDoDestino: [...ETAPAS_DO_FUNIL_B, etapaAbertaDoA],
    });
    const acao = getAction("create_or_move_lead");

    const primeira = await acao!.execute(ctx, CONFIG);
    const segunda = await acao!.execute(ctx, { pipeline_id: FUNIL_A, stage_id: ETAPA_DO_FUNIL_A });

    expect(primeira.status).toBe("success");
    expect(segunda.status).toBe("failed");
    expect(segunda.error).toBe("lead_already_transferred_in_event");
    expect(spies.createLeadHandler).toHaveBeenCalledTimes(1);
    expect(spies.encerraDemanda).toHaveBeenCalledTimes(1);
    // Vale a primeira regra: o negócio das próximas ações segue sendo o clone no funil B.
    expect((ctx.context.lead as Record<string, unknown>).pipeline_id).toBe(FUNIL_B);
  });

  it("o motivo da transferência segue sendo o canônico, não perda comercial", () => {
    expect(MOTIVO_PADRAO_DA_TROCA).toBe(MOTIVO_DA_TRANSFERENCIA);
  });
});
