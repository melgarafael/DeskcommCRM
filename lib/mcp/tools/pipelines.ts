/**
 * MCP read tool — crm_list_pipelines (Spec 11 §3.1).
 */
import { z } from "zod";

import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import { carregarPrevisao } from "@/lib/leads/previsao";
import type { McpToolDefinition } from "../types";

const listInputShape = {
  include_archived: z.boolean().optional().default(false),
};

export const crmListPipelines: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_pipelines",
  description:
    "Lista pipelines do CRM com seus stages (vocabulary inclusa para renomear lead/deal/won/lost por tenant).",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const result = await listPipelinesHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      { include_archived: input.include_archived },
    );
    const onlyOrg = result.pipelines.filter((p) => p.organization_id === ctx.organizationId);
    return {
      pipelines: onlyOrg.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        is_default: p.is_default,
        is_archived: p.is_archived,
        position: p.position,
        vocabulary: p.vocabulary,
      })),
    };
  },
};

const forecastInputShape = {
  pipeline_id: z.string().uuid(),
};

/**
 * A previsão ponderada de UM funil (issue #1535) — a MESMA regra da rota REST
 * `GET /api/v1/pipelines/[id]/forecast`, porque duas réguas para a mesma conta
 * divergem no primeiro ajuste de probabilidade.
 *
 * ⚠️ AQUI O CLIENTE É O DO CONTEXTO (service-role, bypassa RLS), então o
 * isolamento vem do filtro explícito de `organization_id` dentro de
 * `carregarPrevisao`. A rota REST usa o client de SESSÃO de propósito: é ela
 * que tem de respeitar `visibility_mode = "own"` (migration 0036) para um
 * atendente ver só a previsão dos próprios negócios.
 */
export const crmGetPipelineForecast: McpToolDefinition<typeof forecastInputShape> = {
  name: "crm_get_pipeline_forecast",
  description:
    "Devolve a previsão ponderada de um funil: negócios ABERTOS agrupados por moeda e por mês de " +
    "expected_close_date, com bruto_cents e ponderado_cents (valor x probabilidade), mais os baldes " +
    "\"sem data\" e \"sem probabilidade\" reportados À PARTE — nunca somados como zero. A fonte da " +
    "probabilidade vem de crm_pipelines.settings.previsao.fonte: \"etapa\" (padrão) ou " +
    "\"ia_quando_houver\" (usa crm_lead_scores.ai_probability quando existe). Moedas diferentes " +
    "NUNCA são somadas entre si.",
  inputSchema: forecastInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) =>
    carregarPrevisao(ctx.supabase, {
      organizationId: ctx.organizationId,
      pipelineId: input.pipeline_id,
      requestId: ctx.requestId,
    }),
};
