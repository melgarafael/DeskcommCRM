/**
 * MCP tools sobre /api/v1/leads (Spec 11 §3.1, §3.2).
 *
 *  Read:
 *   - crm_list_leads
 *   - crm_get_lead
 *  Write:
 *   - crm_create_lead
 *   - crm_update_lead
 *   - crm_move_lead_stage  (sem mirror REST direto; reusa moveLeadHandler)
 *
 * Write tools exigem role>=manager + scope mcp:write (gate no server core).
 */
import { z } from "zod";

import {
  listLeadsHandler,
  getLeadHandler,
  createLeadHandler,
  updateLeadHandler,
  moveLeadHandler,
  retomarLeadHandler,
} from "@/app/api/v1/leads/_handler";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  CHAVE_DA_REFERENCIA,
  REFERENCIA_EXTERNA,
  descricaoComReferencia,
} from "@/lib/leads/referencia-externa";
import { createLeadSchema, updateLeadSchema } from "@/lib/schemas/leads";
import { completarDestinoDoNegocio } from "@/lib/external-db/receitas/destino-pela-referencia";
import { conferirCamposPersonalizados } from "../conferencia-de-campos";
import { resolveUserNames } from "./_users";
import type { McpContext, McpToolDefinition } from "../types";
import { ApiError } from "@/lib/api/types";

/**
 * A recusa ÚNICA das leituras de negócio durante um turno: negócio de outro
 * cliente, inexistente, de outra organização ou sem contato ligado recebem
 * este MESMO objeto — um uuid não vira oráculo de existência.
 */
const NEGOCIO_FORA_DA_CONVERSA = {
  permitido: false,
  motivo: "fora_da_conversa",
  mensagem:
    "esta conversa é com outra pessoa — um negócio que não é deste cliente não é seu para ver; " +
    "siga a conversa com quem está falando.",
} as const;

/**
 * A recusa de pessoal na ficha de negócio (spec 21, etapa 12).
 *
 * `getLeadHandler` responde 404 tanto para "não existe" quanto para "é de
 * pessoal" (igual à conversa). Só no 404 esta leitura diagnóstica distingue —
 * e o motivo honesto passa na frente do genérico de fora-da-conversa.
 */
const NEGOCIO_CONTATO_PESSOAL = {
  permitido: false,
  motivo: "contato_pessoal",
  mensagem:
    "este negócio é de um contato marcado como pessoal — fora da operação: não leia " +
    "nem escreva aqui; siga a conversa com quem está falando.",
} as const;

async function recusaSeLeadDePessoal(
  ctx: McpContext,
  leadId: string,
): Promise<typeof NEGOCIO_CONTATO_PESSOAL | null> {
  const { data: lead } = await ctx.supabase
    .from("crm_leads")
    .select("contact_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", leadId)
    .maybeSingle();
  const contactId = (lead as { contact_id?: string | null } | null)?.contact_id;
  if (!contactId) return null;
  const { data: contato } = await ctx.supabase
    .from("contacts")
    .select("is_personal")
    .eq("organization_id", ctx.organizationId)
    .eq("id", contactId)
    .maybeSingle();
  return (contato as { is_personal?: boolean } | null)?.is_personal === true
    ? NEGOCIO_CONTATO_PESSOAL
    : null;
}

/**
 * A unidade de `value_cents` DITA AO MODELO. O negócio guarda o valor × 100 em
 * QUALQUER moeda — inclusive guarani, que não tem centavo (ver
 * `formatValorDoNegocio` em `lib/money.ts`) —, e o catálogo não: `preco_cents`
 * vem em unidades da moeda. Sem esta linha a conversão dependia só do prompt de
 * cada organização, e um prompt que esquecesse gravava o pedido cem vezes menor.
 */
const VALOR_DO_NEGOCIO =
  "valor do negócio × 100, em QUALQUER moeda (também guarani): R$ 249,90 → 24990; ₲125.000 → 12500000. " +
  "O preço do catálogo (preco_cents) NÃO segue esta régua em moeda sem centavos: multiplique por 100.";

/**
 * Enriquece rows de lead com os campos de governança aditivos (G6-03):
 * `owner_user_name` (só o nome — LGPD) e `stage` ({ id, name }, o label legível
 * que o get_lead_context compõe). owner_user_id, stage_id, status e tags[] já
 * vêm na row (`select *`); nada existente muda. Dedupe de owners e stages —
 * sem N+1 numa listagem.
 */
async function enrichLeads(
  ctx: McpContext,
  leads: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (leads.length === 0) return leads;

  const names = await resolveUserNames(
    ctx.supabase,
    leads.map((l) => l.owner_user_id as string | null),
  );

  const stageIds = [
    ...new Set(leads.map((l) => l.stage_id).filter((id): id is string => Boolean(id))),
  ];
  const stageById = new Map<string, { id: string; name: string }>();
  if (stageIds.length > 0) {
    const { data } = await ctx.supabase
      .from("crm_stages")
      .select("id, name")
      .eq("organization_id", ctx.organizationId)
      .in("id", stageIds);
    for (const s of (data ?? []) as Array<{ id: string; name: string }>) {
      stageById.set(s.id, { id: s.id, name: s.name });
    }
  }

  return leads.map((l) => ({
    ...l,
    owner_user_name: l.owner_user_id
      ? (names.get(l.owner_user_id as string) ?? null)
      : null,
    stage: l.stage_id ? (stageById.get(l.stage_id as string) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listInputShape = {
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  owner_user_id: z.string().uuid().optional(),
  /** `lost_reason` exato do negócio perdido (issue #1537). */
  lost_reason: z.string().min(1).max(500).optional(),
  /**
   * Categoria do motivo de perda (issue #1537) — resolve pela mesma régua do
   * relatório "Perdas" (`motivosDaCategoria`). Recomendado junto com
   * `pipeline_id`: sem escopo de funil a lista é a união dos funis da org.
   */
  lost_reason_category: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};

export const crmListLeads: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_leads",
  description:
    "Lista leads do CRM filtrando por pipeline, stage, status e owner. Cursor base64 para paginação. " +
    "Governança por lead: owner_user_id + owner_user_name (só o nome do dono, sem email/telefone), stage ({ id, name } legível além do stage_id) e tags[]." +
    " Em conversa de atendimento, lista apenas os negócios do contato desta conversa.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const result = await listLeadsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        pipeline_id: input.pipeline_id,
        stage_id: input.stage_id,
        status: input.status,
        owner_user_id: input.owner_user_id,
        lost_reason: input.lost_reason,
        lost_reason_category: input.lost_reason_category,
        // Escopo do turno NA CONSULTA, antes do limite: filtrar a página depois
        // esconderia negócios do próprio cliente que caíssem fora dela.
        contact_id: ctx.contatoDoTurno,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return {
      leads: await enrichLeads(ctx, result.leads),
      cursor: result.cursor,
      has_more: result.has_more,
    };
  },
};

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

const getInputShape = {
  lead_id: z.string().uuid(),
};

export const crmGetLead: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_lead",
  description:
    "Retorna um lead pelo UUID. Inclui pipeline_id, stage_id, status, owner. " +
    "Governança: owner_user_id + owner_user_name (só o nome, sem email/telefone), stage ({ id, name } legível) e tags[]." +
    " Em conversa de atendimento, só abre negócio do contato desta conversa.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const doTurno = ctx.contatoDoTurno;
    let lead: Record<string, unknown> | null = null;
    try {
      lead = await getLeadHandler(
        ctx.supabase,
        {
          organization_id: ctx.organizationId,
          actor: ctx.actor,
          requestId: ctx.requestId,
        },
        input.lead_id,
      );
    } catch (e: unknown) {
      // Com turno, o `404` vira a MESMA recusa do negócio de outro cliente.
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      // ...exceto quando o negócio EXISTE e é de pessoal: motivo honesto nos
      // dois ingressos. Diagnóstico só neste 404 — fora dele, nada muda.
      const recusa = await recusaSeLeadDePessoal(ctx, input.lead_id);
      if (recusa) return recusa;
      if (!doTurno) throw e;
      lead = null;
    }
    if (doTurno && (!lead || lead.contact_id !== doTurno)) return NEGOCIO_FORA_DA_CONVERSA;
    if (!lead) throw new Error("not_found");
    if ((lead as { organization_id?: string }).organization_id !== ctx.organizationId) {
      // Defesa em profundidade — service-role bypassa RLS.
      throw new Error("not_found");
    }
    const [enriched] = await enrichLeads(ctx, [lead]);
    return { lead: enriched };
  },
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const createInputShape = {
  // Opcionais SÓ por causa da `referencia_externa`: com a referência de um item cuja
  // receita tem funil de destino, o sistema completa os dois (R5c). Sem ela, a
  // ausência é recusada com a mensagem de ensino (`completarDestinoDoNegocio`).
  pipeline_id: z
    .string()
    .uuid()
    .optional()
    .describe("O funil do negócio. Pode ser omitido (junto com stage_id) quando passar referencia_externa de um item cuja receita já tem funil de destino."),
  stage_id: z
    .string()
    .uuid()
    .optional()
    .describe("A etapa do negócio. Pode ser omitida (junto com pipeline_id) quando passar referencia_externa de um item cuja receita já tem funil de destino."),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  contact_id: z.string().uuid().optional(),
  value_cents: z.number().int().nonnegative().optional().describe(VALOR_DO_NEGOCIO),
  currency: z.string().length(3).optional(),
  owner_user_id: z.string().uuid().optional(),
  /** 0070: o agente pode nascer dono do negócio que ele mesmo abriu. */
  owner_agent_id: z.string().uuid().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  /**
   * O item do banco externo que o cliente escolheu (Spec 25, R5a): `<receita>:<id>`,
   * montado do resultado de `crm_consultar_receita`. Fica no negócio para o humano
   * continuar de onde o robô parou, e o mesmo cliente repetindo o interesse no
   * mesmo item NÃO abre outro negócio.
   */
  referencia_externa: z
    .string()
    .regex(REFERENCIA_EXTERNA)
    .optional()
    .describe(
      "Só quando o cliente escolheu UM item de um resultado de receita do banco externo: a referência no formato <receita>:<id> (ex.: wordpress-conteudo:4821), com a receita que veio no resultado e o código (id) do item que está escrito na conversa. Nunca invente. Use junto com o contact_id da conversa; o funil e a etapa saem da receita, então pipeline_id e stage_id podem ser omitidos. O mesmo cliente repetindo o interesse no mesmo item não cria outro negócio.",
    ),
  /**
   * Os campos que o DONO declarou em `pipeline.settings.fields` (#2297).
   *
   * Sem esta chave a ferramenta não tem como criar um negócio numa etapa
   * exigente nem quando o agente JÁ SABE o valor: `z.object` descarta a chave
   * que não declarou, o valor morria antes do `createLeadHandler` — quem
   * pergunta a régua —, e a recusa (422 `required_fields_missing`) acontecia
   * sem que houvesse como evitá-la. Mesmo desenho do `crm_update_lead`, que já
   * declarava a chave; o schema de criação do REST continua sem ela porque lá
   * ela é gerida pelo servidor (o valor entra por fora do `parse`, no handler).
   */
  custom_fields: z.record(z.string(), z.unknown()).optional(),
};

export const crmCreateLead: McpToolDefinition<typeof createInputShape> = {
  name: "crm_create_lead",
  description:
    "Cria um lead no pipeline informado. Use após qualificar um contato. Position é gerenciado pelo servidor.",
  inputSchema: createInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Spec 25 (R5c) — funil e etapa podem faltar quando o agente passa só a
    // referência de um item: o sistema os acha na receita. No turno do agente o
    // wrapper (`lib/ai/runtime/tools.ts`) já completou ANTES do escopo de funil;
    // aqui vale para quem chega por outra porta (MCP externo, rota). Sem nada
    // disso, a ausência é recusada com a mensagem de ensino.
    const destinoArgs: Record<string, unknown> = {
      pipeline_id: input.pipeline_id,
      stage_id: input.stage_id,
      referencia_externa: input.referencia_externa,
    };
    const completo = await completarDestinoDoNegocio(ctx.supabase, ctx.organizationId, destinoArgs);
    if (!completo.ok) return completo.resposta;
    const pipelineId = destinoArgs.pipeline_id as string;
    const stageId = destinoArgs.stage_id as string;

    // Spec 25 (R5a) — o MESMO cliente repetindo o interesse no MESMO item não abre
    // outro negócio: acha o que já está aberto no funil e deixa uma nota na
    // timeline. Só com contato (sem ele não há "mesmo cliente") e só entre os
    // ABERTOS — um negócio perdido ou ganho não impede o interesse novo. Filtra a
    // organização à mão: o cliente de serviço ignora a RLS.
    // No turno do agente o contato TEM de ser o da conversa (a conferência de escopo
    // já o exige antes de chegar aqui; repetida como nas ferramentas irmãs), e o
    // negócio de contato pessoal está fora da operação.
    const doTurno = ctx.contatoDoTurno;
    const contatoDeOutraConversa =
      !!doTurno && !!input.contact_id && input.contact_id.toLowerCase() !== doTurno.toLowerCase();
    if (input.referencia_externa && input.contact_id && !contatoDeOutraConversa) {
      const { data: existente } = await ctx.supabase
        .from("crm_leads")
        .select("id, title, pipeline_id, stage_id, status")
        .eq("organization_id", ctx.organizationId)
        .eq("contact_id", input.contact_id)
        .eq("pipeline_id", pipelineId)
        .eq("status", "open")
        .eq(`source_metadata->>${CHAVE_DA_REFERENCIA}`, input.referencia_externa)
        .limit(1)
        .maybeSingle();
      if (existente) {
        const recusaPessoal = await recusaSeLeadDePessoal(ctx, (existente as { id: string }).id);
        if (recusaPessoal) return recusaPessoal;
        await emitLeadActivity(ctx.supabase, {
          organizationId: ctx.organizationId,
          leadId: (existente as { id: string }).id,
          contactId: input.contact_id,
          type: "note",
          sourceModule: "referencia-externa",
          actor: ctx.actor,
          reason: `O cliente voltou a demonstrar interesse em ${input.referencia_externa}`,
          payload: { [CHAVE_DA_REFERENCIA]: input.referencia_externa },
        });
        return { lead: existente, ja_existia: true };
      }
    }
    const parsed = createLeadSchema.parse({
      pipeline_id: pipelineId,
      stage_id: stageId,
      title: input.title,
      description: input.referencia_externa
        ? descricaoComReferencia(input.description, input.referencia_externa)
        : (input.description ?? null),
      contact_id: input.contact_id ?? null,
      value_cents: input.value_cents ?? null,
      // Ausente, a moeda é a da organização (`createLeadHandler` a lê): um
      // literal "BRL" aqui fazia o agente criar em real numa empresa em euro.
      currency: input.currency,
      owner_user_id: input.owner_user_id ?? null,
      owner_agent_id: input.owner_agent_id ?? null,
      expected_close_date: input.expected_close_date ?? null,
      tags: input.tags ?? [],
      source: input.source ?? "ai_agent",
    });
    // #2234 na CRIAÇÃO (#2302): a mesma conferência do `crm_update_lead`. Sem
    // ela, a chave nova deixava a IA cumprir a régua da etapa com um valor que
    // o cliente não disse. O campo recusado sai do insert; se a etapa o exige,
    // a régua devolve o 422 — coerente: o cliente não disse.
    const conferencia = await conferirCamposPersonalizados(
      ctx,
      { pipelineId },
      input.custom_fields,
    );
    const custom_fields = conferencia.custom_fields ?? input.custom_fields;
    const lead = await createLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      // `custom_fields` entra POR FORA do `createLeadSchema.parse`, de
      // propósito: o schema de criação aceita a chave desde #3038, mas o parse
      // acima não a repassa, porque o valor que vale é o que sai de
      // `conferirCamposPersonalizados` (sem os campos recusados). É a interseção
      // que o webhook de captação também monta. Sem isto o argumento do agente
      // morria aqui dentro, antes da régua que ele precisa satisfazer (#2297,
      // caminho 2).
      {
        ...parsed,
        ...(custom_fields === undefined ? {} : { custom_fields }),
        ...(input.referencia_externa
          ? { source_metadata: { [CHAVE_DA_REFERENCIA]: input.referencia_externa } }
          : {}),
      },
    );
    return {
      lead,
      ...(conferencia.recusados.length > 0
        ? {
            campos_nao_gravados: conferencia.recusados,
            erro_de_ensino: conferencia.recusados.map((r) => r.mensagem).join(" "),
          }
        : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const updateInputShape = {
  lead_id: z.string().uuid(),
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional(),
  contact_id: z.string().uuid().optional(),
  value_cents: z.number().int().nonnegative().optional().describe(VALOR_DO_NEGOCIO),
  currency: z.string().length(3).optional(),
  owner_user_id: z.string().uuid().optional(),
  /** 0070: transferir o negócio para (ou de) um agente — passa pelo mesmo helper. */
  owner_agent_id: z.string().uuid().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: z.array(z.string()).optional(),
  /**
   * Os campos que o DONO declarou em `pipeline.settings.fields`.
   *
   * Faltava aqui, e só aqui: `updateLeadSchema` já aceita a chave, o
   * `updateLeadHandler` já faz o merge com o que existe, e a mudança já vira
   * atividade na linha do tempo ("os campos personalizados"). Como o handler
   * monta `{...rest}` a partir DESTE shape, e `z.object` descarta chave que não
   * declarou, o valor morria antes de chegar ao schema que o aceitaria.
   *
   * Efeito da ausência: o produto deixa criar até 50 campos por funil, desenha
   * todos na ficha do lead — e nenhum agente conseguia preencher um. Quem
   * modelou o funil no vocabulário do próprio nicho recebia a IA como leitora,
   * nunca como escrivã.
   */
  custom_fields: z.record(z.string(), z.unknown()).optional(),
};

export const crmUpdateLead: McpToolDefinition<typeof updateInputShape> = {
  name: "crm_update_lead",
  description:
    "Atualiza campos editáveis de um lead. Stage transitions são via crm_move_lead_stage; status é gerenciado por triggers.",
  inputSchema: updateInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { lead_id, ...rest } = input;
    const parsed = updateLeadSchema.parse(rest);
    // #2234 — a IA só grava o que o CLIENTE disse. A conferência vale só para a
    // origem do agente de IA (tela, API de terceiros e automação passam por
    // aqui sem nenhuma leitura): o degrau 1 confere número, data, e-mail e
    // dinheiro em código, o degrau 2 pergunta ao Jev o que sobrou, e o que o
    // cliente não disse volta como ERRO DE ENSINO para o modelo, com os outros
    // campos da mesma chamada seguindo gravando (`lib/mcp/conferencia-de-campos`).
    const conferencia = await conferirCamposPersonalizados(ctx, { leadId: lead_id }, parsed.custom_fields);
    const lead = await updateLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      lead_id,
      conferencia.custom_fields === undefined
        ? parsed
        : { ...parsed, custom_fields: conferencia.custom_fields },
    );
    return {
      lead,
      ...(conferencia.recusados.length > 0
        ? {
            campos_nao_gravados: conferencia.recusados,
            erro_de_ensino: conferencia.recusados.map((r) => r.mensagem).join(" "),
          }
        : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// move stage
// ---------------------------------------------------------------------------

const moveInputShape = {
  lead_id: z.string().uuid(),
  to_stage_id: z.string().uuid(),
  position_in_stage: z.number().finite().optional(),
  reason: z.string().max(500).optional(),
  /**
   * O motivo do ganho, quando o destino fecha o negócio como ganho (issue #1536).
   * Obrigatório só se o funil ligar `won_reason_required`; sem lista cadastrada
   * o texto é livre. A recusa (`required_fields_missing` /
   * `won_reason_invalid`) volta como erro da tool, e o modelo pergunta ao
   * cliente ou passa para o humano — nunca move calado.
   */
  won_reason: z.string().max(500).optional(),
  /**
   * O motivo da perda, quando o destino é etapa de perda (issue #917). O banco
   * confere contra o vocabulário do funil (canônico + `settings.lost_reasons`) e
   * recusa a perda sem ele. O `moveLeadHandler` já aceitava; a tool descartava.
   * Sem `.min(1)`: motivo em branco é tratado em lib/leads/motivo-da-perda.ts como
   * ausente — a mesma régua do moveLeadSchema e do won_reason; string vazia
   * morrendo no zod daria uma mensagem diferente da recusa de negócio.
   */
  lost_reason: z.string().max(500).optional(),
};

export const crmMoveLeadStage: McpToolDefinition<typeof moveInputShape> = {
  name: "crm_move_lead_stage",
  description:
    "Move um lead para outro stage dentro do MESMO pipeline. Audit registra from/to stage e reason. " +
    "Mover para uma etapa de perda exige lost_reason, com um motivo do vocabulário do funil. " +
    // "use clone" apontava para uma porta que o agente NÃO tem: não existe tool
    // de clone em lib/mcp/tools/, e ele não faz HTTP autenticado por cookie de
    // sessão. Instrução que não pode ser cumprida faz o modelo prometer ao
    // cliente uma ação que nunca acontece — o mesmo defeito da #922, do outro
    // lado. A tool de clone é fatia própria; até lá, a saída honesta é o humano.
    "Levar o negócio para OUTRO funil é proibido aqui e ainda não é uma ferramenta sua: " +
    "não prometa ao cliente que você vai mudar o funil — diga que vai passar para a equipe.",
  inputSchema: moveInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const lead = await moveLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
      {
        to_stage_id: input.to_stage_id,
        position_in_stage: input.position_in_stage,
        reason: input.reason,
        won_reason: input.won_reason,
        lost_reason: input.lost_reason,
      },
    );
    return { lead };
  },
};


// ---------------------------------------------------------------------------
// retomar como novo negócio (issue #1538)
// ---------------------------------------------------------------------------

const retomarInputShape = {
  lead_id: z.string().uuid(),
  /**
   * A etapa da NOVA tentativa, no MESMO funil do negócio original. Sem ela o
   * handler escolhe a primeira etapa aberta do funil.
   */
  stage_id: z.string().uuid().optional(),
};

export const crmRetomarLead: McpToolDefinition<typeof retomarInputShape> = {
  name: "crm_retomar_lead",
  description:
    "Retoma um negócio ENCERRADO (perdido ou ganho) como um negócio NOVO no mesmo funil, com o mesmo contato, " +
    "source='retomada' e retomado_de_lead_id apontando para o original — que NÃO é alterado (status e motivo ficam intactos). " +
    "É o que fazer quando o cliente volta depois de uma venda fechada e a equipe quer uma nova tentativa registrada: " +
    "em funis com reabertura 'novo_negocio', o crm_move_lead_stage devolve 409 reabertura_cria_novo e esta é a porta que resolve. " +
    "O negócio original precisa estar encerrado; um negócio ABERTO é recusado (reabertura_lead_aberto).",
  inputSchema: retomarInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const lead = await retomarLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
      { stage_id: input.stage_id },
    );
    return { lead };
  },
};
