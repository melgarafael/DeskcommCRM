/**
 * MCP read tool — crm_list_pipelines (Spec 11 §3.1).
 */
import { z } from "zod";

import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";
import { carregarPrevisao } from "@/lib/leads/previsao";
import type { McpToolDefinition } from "../types";

const listInputShape = {
  include_archived: z.boolean().optional().default(false),
};

/** Um campo personalizado como o agente precisa dele para escrever (#4667). */
export interface CampoDoFunilParaOAgente {
  key: string;
  label: string;
  type: string;
  escopo: "negocio" | "contato";
  /** Só o `value` de cada opção: é o que `custom_fields` grava. */
  options?: string[];
}

/**
 * As DEFINIÇÕES dos campos do funil, nunca valor de negócio (#4667).
 *
 * Sem esta lista o agente não tinha como saber a chave de um campo e inventava
 * uma em `custom_fields`. O `settings` já vinha do `listPipelinesHandler` e
 * morria no `map` da ferramenta. Vão os dois escopos: o `escopo` diz qual é do
 * negócio (o que `crm_update_lead` grava) e qual é do contato.
 */
export function camposDoFunilParaOAgente(settings: unknown): CampoDoFunilParaOAgente[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  return camposDoFunil(settings as Record<string, unknown>).map((campo) => ({
    key: campo.key,
    label: campo.label,
    type: campo.type,
    escopo: escopoDoCampo(campo),
    ...(campo.options && campo.options.length > 0
      ? { options: campo.options.map((opcao) => opcao.value) }
      : {}),
  }));
}

export const crmListPipelines: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_pipelines",
  description:
    "Lista os funis do CRM (vocabulary renomeia lead/deal/won/lost por tenant) e os campos de cada um (fields): em custom_fields, use só essas key.",
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
        fields: camposDoFunilParaOAgente(p.settings),
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
    "Previsão ponderada de um funil: negócios ABERTOS por moeda e por mês de expected_close_date, " +
    "em DUAS parcelas por balde: unico (value_cents) e recorrente_mensal (mensalidade), cada uma " +
    "com bruto_cents e ponderado_cents. Nunca somadas. Os baldes \"sem data\" e \"sem " +
    "probabilidade\" vão À PARTE, nunca como zero. Fonte em " +
    "crm_pipelines.settings.previsao.fonte: \"etapa\" ou \"ia_quando_houver\" (ai_probability). " +
    "Moedas diferentes NUNCA somam. truncado: true quando o funil passa do teto de leitura; valores parciais.",
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
