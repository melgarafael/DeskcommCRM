/**
 * A REGRA QUE TROCA DE FUNIL TRANSFERE O NEGÓCIO — NÃO ABRE UM SEGUNDO (#992).
 *
 * ═══ O defeito, medido antes do conserto ═══
 *
 * A ação `create_or_move_lead` de uma regra com gatilho de CONTATO procurava o
 * negócio aberto do contato SÓ no funil de destino (`negocioAbertoDoContato`,
 * que filtra por `pipeline_id`). Contato com negócio aberto em OUTRO funil não
 * era encontrado, e a execução caía no `createLeadHandler`: o cliente ficava com
 * DOIS negócios abertos, um em cada funil, e a origem continuava aberta no funil
 * antigo como se nada tivesse acontecido. Quem olha dois cards iguais não sabe
 * qual dos dois a equipe está tocando.
 *
 * ═══ O que este arquivo vigia ═══
 *
 * A decisão da ação, que é uma só: com negócio aberto em OUTRO funil, a regra
 * TRANSFERE — clona para o funil dela (`montaPayloadDoClone`) e encerra a origem
 * como perdida com o motivo de transferência —, e o CLONE segue para as ações
 * seguintes da mesma regra (`publicaNoContexto`).
 *
 * Casos 2 e 3 são controles: negócio aberto no MESMO funil continua sendo movido
 * de etapa (nada é encerrado, nada é criado), e sem negócio aberto a ação cria,
 * como sempre criou. Sem eles, um "conserto" que passasse a clonar em todo caso
 * passaria aqui.
 *
 * ═══ O motivo, e as duas metades dele ═══
 *
 * O último bloco prende o NOME do motivo nos três lugares que precisam concordar:
 * o vocabulário do código (`CANONICAL_LOST_REASONS`), o array canônico do trigger
 * `fn_validate_lost_reason_required` e o filtro de perdas de `fn_attendant_metrics`.
 * O motivo da transferência não é perda comercial: se ele não existir no trigger,
 * o banco recusa o encerramento com `lost_reason_invalid` (22023) e a origem fica
 * aberta — o defeito de novo, agora com o clone já criado.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

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
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import type { ActionCtx } from "@/lib/automation/types";

import "@/lib/automation/actions/create-or-move-lead";

const MOTIVO_DA_TRANSFERENCIA = "moved_to_another_pipeline";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "c0c0c0c0-0000-0000-0000-000000000001";
const FUNIL_DA_REGRA = "f0f0f0f0-0000-0000-0000-000000000002";
const OUTRO_FUNIL = "f0f0f0f0-0000-0000-0000-000000000003";
const ETAPA_INICIAL = "e0e0e0e0-0000-0000-0000-000000000001";
const ETAPA_ESCOLHIDA = "e0e0e0e0-0000-0000-0000-000000000002";
const ETAPA_DE_PERDA = "e0e0e0e0-0000-0000-0000-0000000000ff";

const TITULO_DA_ORIGEM = "Reforma da cozinha";
const NEGOCIO_EM_OUTRO_FUNIL = {
  id: "1ea1-0000-0000-0000-000000000001",
  pipeline_id: OUTRO_FUNIL,
  status: "open",
  title: TITULO_DA_ORIGEM,
  contact_id: CONTATO,
  value_cents: 250000,
  currency: "BRL",
  tags: ["orcamento"],
  source: "whatsapp",
  custom_fields: { ambiente: "cozinha" },
  source_metadata: {},
};

const ETAPAS_DO_DESTINO = [
  {
    id: ETAPA_INICIAL,
    pipeline_id: FUNIL_DA_REGRA,
    position: 1,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
  {
    id: ETAPA_ESCOLHIDA,
    pipeline_id: FUNIL_DA_REGRA,
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

function contexto(cenarios: Parameters<typeof adminFalso>[0] = {}) {
  const ctx = {
    admin: adminFalso(cenarios),
    organizationId: ORG,
    ruleId: "r0r0r0r0-0000-0000-0000-000000000001",
    ruleName: "Novo negócio no funil A",
    event: {},
    context: {
      contact: { id: CONTATO, name: "Marina Prado", phone_number: "+5511900000000" },
    },
    requestId: "rule:r0r0r0r0-0000-0000-0000-000000000001",
  } as unknown as ActionCtx;
  return ctx;
}

const CONFIG = { pipeline_id: FUNIL_DA_REGRA, stage_id: ETAPA_ESCOLHIDA };

/** O TERCEIRO argumento de uma chamada (admin, ctx, payload) — sem `[0][2]` solto. */
function argumentoDaChamada(
  spy: { mock: { calls: unknown[][] } },
  indice = 0,
): Record<string, unknown> {
  const chamada = spy.mock.calls[indice];
  expect(chamada).toBeDefined();
  return (chamada as unknown[])[2] as Record<string, unknown>;
}

describe("create_or_move_lead — a regra transfere o negócio entre funis", () => {
  it("O DEFEITO: contato com negócio aberto em OUTRO funil transfere, não cria um segundo", async () => {
    spies.createLeadHandler.mockReset();
    spies.moveLeadHandler.mockReset();
    spies.encerraDemanda.mockReset();
    spies.createLeadHandler.mockResolvedValue({
      id: "clone-0001",
      pipeline_id: FUNIL_DA_REGRA,
      stage_id: ETAPA_ESCOLHIDA,
      contact_id: CONTATO,
    });
    spies.encerraDemanda.mockResolvedValue({ lead: { id: NEGOCIO_EM_OUTRO_FUNIL.id } });

    const ctx = contexto({ negocioEmOutroFunil: NEGOCIO_EM_OUTRO_FUNIL, etapasDoDestino: ETAPAS_DO_DESTINO, etapaDePerda: { id: ETAPA_DE_PERDA } });
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");

    // O negócio do destino nasce com os dados da origem — não é um negócio em branco.
    expect(spies.createLeadHandler).toHaveBeenCalledTimes(1);
    const payload = argumentoDaChamada(spies.createLeadHandler);
    expect(payload.pipeline_id).toBe(FUNIL_DA_REGRA);
    expect(payload.stage_id).toBe(ETAPA_ESCOLHIDA);
    expect(payload.title).toBe(TITULO_DA_ORIGEM);
    expect(payload.contact_id).toBe(CONTATO);
    expect(payload.value_cents).toBe(250000);
    expect(payload.custom_fields).toEqual({ ambiente: "cozinha" });
    expect(payload.source_metadata).toMatchObject({
      clonado_de: { lead_id: NEGOCIO_EM_OUTRO_FUNIL.id, pipeline_id: OUTRO_FUNIL },
    });

    // A origem fecha como PERDIDA, com o motivo da transferência.
    expect(spies.encerraDemanda).toHaveBeenCalledTimes(1);
    const encerramento = argumentoDaChamada(spies.encerraDemanda);
    expect(encerramento.leadId).toBe(NEGOCIO_EM_OUTRO_FUNIL.id);
    expect(encerramento.desfecho).toBe("lost");
    expect(encerramento.motivo).toBe(MOTIVO_DA_TRANSFERENCIA);
    expect(encerramento.payloadNaTimeline).toMatchObject({ to_pipeline_id: FUNIL_DA_REGRA });

    // E o CLONE é o negócio que as próximas ações da regra enxergam.
    const publicado = (ctx.context.lead ?? {}) as Record<string, unknown>;
    expect(publicado.id).toBe("clone-0001");
    expect(spies.moveLeadHandler).not.toHaveBeenCalled();
  });

  it("CONTROLE: negócio aberto no MESMO funil continua sendo movido de etapa", async () => {
    spies.createLeadHandler.mockReset();
    spies.moveLeadHandler.mockReset();
    spies.encerraDemanda.mockReset();
    spies.moveLeadHandler.mockResolvedValue({ id: "no-mesmo-funil", pipeline_id: FUNIL_DA_REGRA });

    const ctx = contexto({ negocioNoFunilDaRegra: { id: "no-mesmo-funil" }, etapasDoDestino: ETAPAS_DO_DESTINO, etapaDePerda: { id: ETAPA_DE_PERDA } });
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
  });

  it("CONTROLE: sem negócio aberto, a ação cria — como sempre criou", async () => {
    spies.createLeadHandler.mockReset();
    spies.moveLeadHandler.mockReset();
    spies.encerraDemanda.mockReset();
    spies.createLeadHandler.mockResolvedValue({ id: "novo-0001", contact_id: CONTATO });

    const ctx = contexto({ etapasDoDestino: ETAPAS_DO_DESTINO });
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("success");
    expect(spies.createLeadHandler).toHaveBeenCalledTimes(1);
    const payload = argumentoDaChamada(spies.createLeadHandler);
    expect(payload.source).toBe("automation");
    expect(payload.title).toBe("Marina Prado");
    expect(payload.source_metadata).toBeUndefined();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
  });

  it("a origem sem etapa de perda é recusa explícita, nunca meia transferência", async () => {
    spies.createLeadHandler.mockReset();
    spies.encerraDemanda.mockReset();
    spies.createLeadHandler.mockResolvedValue({ id: "clone-0002" });

    const ctx = contexto({
      negocioEmOutroFunil: NEGOCIO_EM_OUTRO_FUNIL,
      etapasDoDestino: ETAPAS_DO_DESTINO,
      etapaDePerda: null,
    });
    const acao = getAction("create_or_move_lead");
    const resultado = await acao!.execute(ctx, CONFIG);

    expect(resultado.status).toBe("failed");
    expect(spies.createLeadHandler).not.toHaveBeenCalled();
    expect(spies.encerraDemanda).not.toHaveBeenCalled();
  });
});

describe("o motivo da transferência — as duas metades do mesmo nome", () => {
  const raiz = process.cwd();
  const baseline = readFileSync(path.join(raiz, "supabase/baseline.sql"), "utf8");

  it("é o padrão da troca e entra no vocabulário do código", () => {
    expect(MOTIVO_PADRAO_DA_TROCA).toBe(MOTIVO_DA_TRANSFERENCIA);
    expect([...CANONICAL_LOST_REASONS]).toContain(MOTIVO_DA_TRANSFERENCIA);
  });

  it("o trigger aceita o motivo — senão o banco recusa o encerramento com 22023", () => {
    // A ÚLTIMA definição é a que vale no banco (apêndice da 0266, depois do dump).
    const corte = baseline.lastIndexOf(
      "create or replace function public.fn_validate_lost_reason_required",
    );
    expect(corte).toBeGreaterThan(0);
    expect(baseline.slice(corte, corte + 2000)).toContain(`'${MOTIVO_DA_TRANSFERENCIA}'`);
  });

  it("a métrica de perdas não conta a transferência", () => {
    // A ÚLTIMA definição é a que vale (o irmão acima já faz isso): a função tem
    // TRÊS no arquivo — dump, apêndice e apêndice — e o `indexOf` pelo NOME
    // parava na do dump, a definição morta. O recorte daqui até o fim do
    // arquivo é satisfeito pela viva (CLAUDE.md, item 10).
    const corte = baseline.lastIndexOf("create or replace function public.fn_attendant_metrics(");
    expect(corte, "fn_attendant_metrics não encontrada no baseline").toBeGreaterThan(-1);
    const metrica = baseline.slice(corte);
    expect(metrica).toContain(`coalesce(lost_reason, '') <> '${MOTIVO_DA_TRANSFERENCIA}'`);
  });

  it("a migration 0266 existe, está no baseline e no MANIFEST", () => {
    const arquivos = readFileSync(path.join(raiz, "supabase/migrations/MANIFEST.md"), "utf8");
    expect(arquivos).toContain("0266_");
    expect(baseline).toContain("migration 0266");
  });
});
