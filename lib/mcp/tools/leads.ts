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
import { createLeadSchema, updateLeadSchema } from "@/lib/schemas/leads";
import { resolveUserNames } from "./_users";
import type { McpContext, McpToolDefinition } from "../types";

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
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};

export const crmListLeads: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_leads",
  description:
    "Lista leads do CRM filtrando por pipeline, stage, status e owner. Cursor base64 para paginação. " +
    "Governança por lead: owner_user_id + owner_user_name (só o nome do dono, sem email/telefone), stage ({ id, name } legível além do stage_id) e tags[].",
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
    "Governança: owner_user_id + owner_user_name (só o nome, sem email/telefone), stage ({ id, name } legível) e tags[].",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const lead = await getLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
    );
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
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  contact_id: z.string().uuid().optional(),
  value_cents: z.number().int().nonnegative().optional(),
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
    const parsed = createLeadSchema.parse({
      pipeline_id: input.pipeline_id,
      stage_id: input.stage_id,
      title: input.title,
      description: input.description ?? null,
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
    const lead = await createLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      parsed,
    );
    return { lead };
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
  value_cents: z.number().int().nonnegative().optional(),
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
    const lead = await updateLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      lead_id,
      parsed,
    );
    return { lead };
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
};

export const crmMoveLeadStage: McpToolDefinition<typeof moveInputShape> = {
  name: "crm_move_lead_stage",
  description:
    "Move um lead para outro stage dentro do MESMO pipeline. Audit registra from/to stage e reason. " +
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
