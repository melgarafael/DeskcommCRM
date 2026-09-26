/**
 * Capacidades de ORGANIZAR A OPERAÇÃO — funil, marcadores, respostas prontas,
 * entradas automáticas de contatos, regras automáticas e time (épico IA 360, W4).
 *
 * O agente atendia dentro de uma estrutura que não podia ajustar nem explicar:
 * zero capacidades sobre `webhook_sources` e `automation_rules`, e nem sequer
 * criar uma etapa de funil.
 *
 * ⚠️ TODA REGRA VIVE EM `lib/operacao/` E `lib/leads/stage-operations.ts`. Aqui
 * há tradução de argumento e nada mais — as mesmas funções servem as rotas REST
 * (BRIEFING §3, Decisão 4). Se você está prestes a escrever um `.from(...)` neste
 * arquivo, a regra está no lugar errado.
 *
 * ⚠️ A ORGANIZAÇÃO SAI SEMPRE DE `ctx.organizationId`, NUNCA DO INPUT. O client
 * do contexto é service-role e bypassa RLS; o filtro explícito por organização
 * está dentro de cada função de `lib/operacao/` e é a única coisa que separa os
 * tenants aqui.
 *
 * ⚠️ O QUE ESTE ARQUIVO DELIBERADAMENTE **NÃO** DÁ AO AGENTE: criar/editar/apagar
 * regra automática (ele liga e desliga o que um humano escreveu, nunca escolhe
 * para onde a empresa manda dados), mudar papel de ninguém, apagar entrada
 * automática, e criar resposta pronta. Ver o cabeçalho de cada módulo de
 * `lib/operacao/` para o porquê de cada uma.
 */
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ApiError } from "@/lib/api/types";
import {
  arquivarEtapa,
  atualizarEtapa,
  criarEtapa,
  lerFunil,
  corpo as corpoDoFunil,
} from "@/lib/leads/stage-operations";
import {
  criarEntradaAutomatica,
  definirEntradaAtiva,
  listarEntradasAutomaticas,
  recebimentosDaEntrada,
  type DepsDaOperacao,
} from "@/lib/operacao/entradas-automaticas";
import { listarMarcadores, listarTime } from "@/lib/operacao/marcadores-e-time";
import {
  CHAVE_DE_VALOR_MAX,
  VALOR_DE_VARIAVEL_MAX,
  listarModelosDeMensagem,
  preencherModeloDeMensagem,
} from "@/lib/operacao/modelos-de-mensagem";
import {
  definirRegraAtiva,
  execucoesDasRegras,
  listarRegrasAutomaticas,
} from "@/lib/operacao/regras-automaticas";
import type { McpContext, McpToolDefinition } from "../types";

/** O contexto MCP traduzido para o que as operações pedem. */
function deps(ctx: McpContext): DepsDaOperacao {
  return {
    supabase: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
  };
}

// ---------------------------------------------------------------------------
// funil e etapas
// ---------------------------------------------------------------------------

const listStagesShape = {
  pipeline_id: z.string().uuid(),
};

export const crmListStages: McpToolDefinition<typeof listStagesShape> = {
  name: "crm_list_stages",
  description:
    "Lista as etapas ativas de um pipeline, na ordem do quadro, com id, name, slug, position, " +
    "is_won/is_lost, win_probability (probabilidade de ganho 0-100 ou null quando a etapa nao foi " +
    "calibrada) e a autoria da última mudança de configuração (last_change_actor_kind: user|ai|system). " +
    "Use antes de mover um lead ou de criar etapa nova, para não duplicar coluna existente.",
  inputSchema: listStagesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const etapas = await lerFunil(ctx.supabase, ctx.organizationId, input.pipeline_id);
    if (!etapas) {
      throw new ApiError(404, "not_found", undefined, ctx.requestId, "Funil não encontrado.");
    }
    return corpoDoFunil(etapas);
  },
};

const createStageShape = {
  pipeline_id: z.string().uuid(),
  name: z.string().min(1).max(80),
};

export const crmCreateStage: McpToolDefinition<typeof createStageShape> = {
  name: "crm_create_stage",
  description:
    "Cria uma etapa no FIM do pipeline informado. O slug e a position são calculados no servidor. " +
    "Recusa nome que o usuário leria como duplicado (ignora acento e caixa). Não cria etapa de ganho/perda — " +
    "para isso use crm_update_stage depois.",
  inputSchema: createStageShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { stageId, funil } = await criarEtapa(deps(ctx), {
      pipelineId: input.pipeline_id,
      nome: input.name,
    });
    return { stage_id: stageId, ...funil };
  },
};

const updateStageShape = {
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  name: z.string().min(1).max(80).optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
  /** Id da etapa VIZINHA DA ESQUERDA; `null` = primeira coluna. Não é posição numérica. */
  after_stage_id: z.string().uuid().nullable().optional(),
  /**
   * Probabilidade de GANHO da etapa, 0–100 (migration 0426). `null` limpa a
   * calibração: a previsão volta a reportar a etapa no balde "sem
   * probabilidade" em vez de somar zero em silêncio.
   */
  win_probability: z.number().int().min(0).max(100).nullable().optional(),
};

export const crmUpdateStage: McpToolDefinition<typeof updateStageShape> = {
  name: "crm_update_stage",
  description:
    "Renomeia, reordena, calibra a probabilidade de ganho (win_probability, 0-100; null limpa a " +
    "calibração e a previsão passa a reportar a etapa sem probabilidade) ou muda o papel de desfecho " +
    "(is_won/is_lost) de uma etapa. " +
    "after_stage_id é o id da etapa VIZINHA DA ESQUERDA (null = primeira coluna), não um número de posição. " +
    "Mover a marcação de ganho/perda para outra etapa é permitido; REMOVÊ-LA sem substituta não é — " +
    "o pipeline ficaria sem onde fechar negócio.",
  inputSchema: updateStageShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const pedido: Parameters<typeof atualizarEtapa>[1]["pedido"] = {};
    if (input.name !== undefined) pedido.name = input.name;
    if (input.is_won !== undefined) pedido.is_won = input.is_won;
    if (input.is_lost !== undefined) pedido.is_lost = input.is_lost;
    if (input.after_stage_id !== undefined) pedido.depois_de = input.after_stage_id;
    if (input.win_probability !== undefined) pedido.win_probability = input.win_probability;
    if (Object.keys(pedido).length === 0) {
      throw new ApiError(
        422,
        "unprocessable_entity",
        undefined,
        ctx.requestId,
        "Diga o que mudar na etapa: o nome, a ordem ou o papel dela no desfecho do negócio.",
      );
    }
    const { funil } = await atualizarEtapa(deps(ctx), {
      pipelineId: input.pipeline_id,
      stageId: input.stage_id,
      pedido,
    });
    return funil;
  },
};

const archiveStageShape = {
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  /** Para onde vão os leads que estão nela. Obrigatório se a etapa não estiver vazia. */
  move_leads_to_stage_id: z.string().uuid().nullable().default(null),
};

export const crmArchiveStage: McpToolDefinition<typeof archiveStageShape> = {
  name: "crm_archive_stage",
  description:
    "Arquiva uma etapa (nunca apaga — crm_leads_stage_id_fkey é ON DELETE RESTRICT e o histórico aponta para ela). " +
    "Exige move_leads_to_stage_id quando a etapa tem leads; o destino não pode ser a etapa de ganho nem a de perda " +
    "(daria os negócios por encerrados). Cada lead movido ganha uma atividade na própria timeline explicando o porquê.",
  inputSchema: archiveStageShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { funil, negociosMovidos } = await arquivarEtapa(deps(ctx), {
      pipelineId: input.pipeline_id,
      stageId: input.stage_id,
      destinoId: input.move_leads_to_stage_id,
    });
    return { leads_movidos: negociosMovidos, ...funil };
  },
};

// ---------------------------------------------------------------------------
// marcadores
// ---------------------------------------------------------------------------

const listTagsShape = {
  limit: z.number().int().min(1).max(200).default(60),
};

export const crmListTags: McpToolDefinition<typeof listTagsShape> = {
  name: "crm_list_tags",
  description:
    "Lista os marcadores (tags) que a organização já usa, com a contagem de conversas de cada um e se ele está no " +
    "vocabulário canônico da org. Chame ANTES de crm_manage_tags: aplicar 'cliente-vip' quando já existe 'vip' " +
    "quebra os filtros de quem opera. Ordenado pelos mais usados.",
  inputSchema: listTagsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    return { marcadores: await listarMarcadores(deps(ctx), { limite: input.limit }) };
  },
};

// ---------------------------------------------------------------------------
// respostas prontas
// ---------------------------------------------------------------------------

const listTemplatesShape = {
  incluir_pessoais: z.boolean().default(false),
};

export const crmListMessageTemplates: McpToolDefinition<typeof listTemplatesShape> = {
  name: "crm_list_message_templates",
  description:
    "Lista as respostas prontas COMPARTILHADAS da organização: título, corpo com as marcações {{...}}, " +
    "`variaveis` (as marcações que o corpo usa), o atalho e se é compartilhada ou pessoal. Use quando a " +
    "empresa já tiver decidido como diz algo, em vez de escrever do zero. Os modelos PESSOAIS de cada " +
    "atendente NÃO entram na lista — `incluir_pessoais` só mostra os do próprio usuário da chamada, e " +
    "um token de integração não tem modelo pessoal nenhum.",
  inputSchema: listTemplatesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    return {
      modelos: await listarModelosDeMensagem(deps(ctx), {
        incluirPessoais: input.incluir_pessoais,
      }),
    };
  },
};

const renderTemplateShape = {
  template_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  valores: z
    .record(
      z.string().regex(/^[a-z_]+$/).max(CHAVE_DE_VALOR_MAX),
      z.string().max(VALOR_DE_VARIAVEL_MAX),
    )
    .optional()
    .describe(
      "Valores para as marcações que NÃO saem do contato nem do negócio — link do formulário, valor " +
        "em aberto, número de protocolo: { link_formulario: \"https://…\" }. As chaves são as marcações " +
        "que o modelo usa (veja `variaveis` em crm_list_message_templates).",
    ),
};

/** Tira os VALORES do audit: o texto montado é do cliente, o log guarda quais variáveis vieram. */
function redigirValores(args: Record<string, unknown>): Record<string, unknown> {
  const valores = args.valores;
  if (!valores || typeof valores !== "object") return args;
  return { ...args, valores: Object.keys(valores).sort() };
}

export const crmRenderMessageTemplate: McpToolDefinition<typeof renderTemplateShape> = {
  name: "crm_render_message_template",
  description:
    "Preenche uma resposta pronta com os dados do contato/lead informados e devolve o TEXTO — não envia nada. " +
    "`valores` preenche o que só quem chama sabe (link, valor, protocolo); variável fora do formato, " +
    "do contato/negócio ou que o modelo não usa é RECUSADA com o nome dela. Devolve também `lacunas`: as " +
    "marcações que ficaram sem valor. Se vier lacuna, NÃO mande o texto como está: 'Olá , tudo bem?' chega " +
    "assim no cliente.",
  inputSchema: renderTemplateShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  redigirParaAuditoria: redigirValores,
  handler: async (input, ctx) => {
    return preencherModeloDeMensagem(deps(ctx), {
      templateId: input.template_id,
      contactId: input.contact_id,
      leadId: input.lead_id,
      valores: input.valores,
    });
  },
};

// ---------------------------------------------------------------------------
// entradas automáticas de contatos (webhook_sources)
// ---------------------------------------------------------------------------

const listSourcesShape = {
  only_active: z.boolean().default(false),
};

export const crmListWebhookSources: McpToolDefinition<typeof listSourcesShape> = {
  name: "crm_list_webhook_sources",
  description:
    "Lista as entradas automáticas de contatos da org: nome, se está ativa, para qual pipeline/stage " +
    "manda, quando recebeu pela última vez e a autoria da última mudança. O segredo nunca sai — só `has_secret`.",
  inputSchema: listSourcesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    return { entradas: await listarEntradasAutomaticas(deps(ctx), { apenasAtivas: input.only_active }) };
  },
};

const sourceEventsShape = {
  source_id: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(20),
};

export const crmListWebhookSourceEvents: McpToolDefinition<typeof sourceEventsShape> = {
  name: "crm_list_webhook_source_events",
  description:
    "Últimos recebimentos de uma entrada automática: quando chegou, se a assinatura era válida, o status e os NOMES " +
    "dos campos que vieram. Os VALORES não são devolvidos (são dados pessoais de quem preencheu o formulário) — " +
    "para diagnosticar 'o site manda full_name e a entrada espera name', os nomes bastam.",
  inputSchema: sourceEventsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    return {
      recebimentos: await recebimentosDaEntrada(deps(ctx), {
        id: input.source_id,
        limite: input.limit,
      }),
    };
  },
};

const createSourceShape = {
  name: z.string().min(1).max(120),
  default_pipeline_id: z.string().uuid(),
  default_stage_id: z.string().uuid(),
  /** Segredo opcional de assinatura. Cifrado no servidor; nunca volta em leitura. */
  secret: z.string().min(16).max(200).optional(),
};

export const crmCreateWebhookSource: McpToolDefinition<typeof createSourceShape> = {
  name: "crm_create_webhook_source",
  description:
    "Cria uma entrada automática de contatos e devolve o path_token da URL de captação. " +
    "O pipeline e o stage têm que ser da MESMA organização e o stage têm que pertencer ao pipeline; " +
    "stage arquivado é recusado (os contatos cairiam numa coluna fora do quadro). " +
    "A entrada nasce ATIVA: a partir daí, qualquer POST na URL vira contato.",
  inputSchema: createSourceShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Segredo nunca fica em claro no banco (migration 0041). Sem chave de cifra
    // configurada, RECUSA em vez de degradar para plaintext — mesma decisão da rota.
    let secretEncrypted: string | null = null;
    if (input.secret) {
      secretEncrypted = await encryptWebhookSecret(createAdminClient(), input.secret);
      if (secretEncrypted === null) {
        throw new ApiError(
          422,
          "encryption_unavailable",
          undefined,
          ctx.requestId,
          "Não foi possível guardar o segredo com segurança. Crie a entrada sem segredo ou peça para configurarem a chave de cifra do banco.",
        );
      }
    }

    return criarEntradaAutomatica(deps(ctx), {
      name: input.name,
      default_pipeline_id: input.default_pipeline_id,
      default_stage_id: input.default_stage_id,
      secret_encrypted: secretEncrypted,
    });
  },
};

const setSourceActiveShape = {
  source_id: z.string().uuid(),
  is_active: z.boolean(),
};

export const crmSetWebhookSourceActive: McpToolDefinition<typeof setSourceActiveShape> = {
  name: "crm_set_webhook_source_active",
  description:
    "Liga ou desliga uma entrada automática de contatos. Desligar faz o formulário que já está publicado no site do " +
    "cliente PARAR de virar contato imediatamente — ninguém é avisado do outro lado. Confirme com um humano antes de desligar.",
  inputSchema: setSourceActiveShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    return definirEntradaAtiva(deps(ctx), { id: input.source_id, ativa: input.is_active });
  },
};

// ---------------------------------------------------------------------------
// regras automáticas (automation_rules)
// ---------------------------------------------------------------------------

const listRulesShape = {
  only_active: z.boolean().default(false),
};

export const crmListAutomationRules: McpToolDefinition<typeof listRulesShape> = {
  name: "crm_list_automation_rules",
  description:
    "Lista as regras automáticas da org: nome, se está ligada, qual evento a dispara, os TIPOS de ação que ela executa, " +
    "quantas condições tem, quando rodou pela última vez e quantas vezes. A configuração das ações (URL de destino, " +
    "segredo, texto) não é devolvida.",
  inputSchema: listRulesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    return { regras: await listarRegrasAutomaticas(deps(ctx), { apenasAtivas: input.only_active }) };
  },
};

const listRunsShape = {
  rule_id: z.string().uuid().optional(),
  only_failures: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
};

export const crmListAutomationRuns: McpToolDefinition<typeof listRunsShape> = {
  name: "crm_list_automation_runs",
  description:
    "Histórico do que as regras automáticas dispararam (mais recentes primeiro): qual regra, status " +
    "(success|partial|failed), quando, e o detalhe SÓ das ações que falharam. Use only_failures=true para responder " +
    "'o que parou de funcionar?'. Sem rule_id, traz a org inteira.",
  inputSchema: listRunsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    return {
      execucoes: await execucoesDasRegras(deps(ctx), {
        ruleId: input.rule_id,
        limite: input.limit,
        apenasFalhas: input.only_failures,
      }),
    };
  },
};

const setRuleActiveShape = {
  rule_id: z.string().uuid(),
  is_active: z.boolean(),
};

export const crmSetAutomationRuleActive: McpToolDefinition<typeof setRuleActiveShape> = {
  name: "crm_set_automation_rule_active",
  description:
    "Liga ou desliga uma regra automática. LIGAR faz a regra rodar sozinha em TODO evento que casar, indefinidamente, " +
    "sem ninguém assistindo — e as ações podem enviar mensagem ao cliente ou mandar dados para fora da empresa. " +
    "Confira as ações com crm_list_automation_rules antes, e confirme com um humano. " +
    "Criar, editar e apagar regra não é possível por aqui, de propósito.",
  inputSchema: setRuleActiveShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    return definirRegraAtiva(deps(ctx), { id: input.rule_id, ativa: input.is_active });
  },
};

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

const listTeamShape = {};

export const crmListTeamMembers: McpToolDefinition<typeof listTeamShape> = {
  name: "crm_list_team_members",
  description:
    "Lista quem trabalha na organização: user_id, papel (viewer|agent|manager|admin) e se o convite ainda está pendente. " +
    "É o user_id que crm_assign_conversation consome. Não devolve e-mail nem nome — o agente precisa saber a quem " +
    "direcionar, não a identidade pessoal de cada um. Somente leitura: mudar papel não é possível por aqui.",
  inputSchema: listTeamShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    return { time: await listarTime(deps(ctx)) };
  },
};
