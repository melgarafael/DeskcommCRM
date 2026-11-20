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

/**
 * OS CAMPOS DO FUNIL COMO O MODELO PRECISA LER (issue #4667).
 *
 * A definição mora em `crm_pipelines.settings.fields[]` (`customFieldSchema`,
 * `lib/schemas/settings.ts:184`) e a leitura é `camposDoFunil` — a MESMA que a
 * ficha, o card e as regras usam, para a lista do modelo não divergir da tela.
 *
 * Sem ela o agente não tinha como saber a CHAVE de um campo e inventava uma em
 * `custom_fields` (`"valor"` em vez de `valor_do_contrato`): a escrita passava,
 * porque o schema aceita chave livre, e o valor ficava órfão no card — o
 * defeito mudo que `lib/mcp/tools/leads.test.ts` documenta do outro lado.
 *
 * O mínimo que o modelo precisa para NÃO inventar: `key`, `label`, `type`, o
 * `escopo` (negócio ou contato — muda ONDE o valor é gravado) e, nos campos de
 * lista, os `options[].value` aceitos. `required`, `padrao` e `mostrar_quando`
 * ficam de fora de propósito: é resposta de leitura que vai inteira em todo
 * turno, e a régua de valor é do servidor (`lib/leads/campos-exigidos.ts`).
 *
 * `options` SÓ aparece quando o campo declara opções — `options: []` em todo
 * campo de texto seria ruído pago em token por chamada.
 */
function camposParaOModelo(settings: Record<string, unknown> | null) {
  return camposDoFunil(settings).map((campo) => ({
    key: campo.key,
    label: campo.label,
    type: campo.type,
    escopo: escopoDoCampo(campo),
    ...(campo.options && campo.options.length > 0
      ? { options: campo.options.map((o) => ({ value: o.value, label: o.label })) }
      : {}),
  }));
}

export const crmListPipelines: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_pipelines",
  description:
    "Lista pipelines do CRM com seus stages (vocabulary inclusa para renomear lead/deal/won/lost por tenant) " +
    "e, por funil, os CAMPOS em `campos`: key, label, type, escopo (negocio/contato) e options[].value. " +
    "Em `custom_fields` use SEMPRE a key daqui — chave inventada não vira campo do funil.",
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
        campos: camposParaOModelo(p.settings),
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
