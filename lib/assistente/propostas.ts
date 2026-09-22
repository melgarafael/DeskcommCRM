import { z } from "zod";

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import type { Role } from "@/lib/auth/types";
import { audit } from "@/lib/audit";
import { criarPedidoComercial } from "@/lib/comercial/criar-pedido";
import { emitirNota } from "@/lib/fiscal/emitir-nota";
import { COLUNAS_DA_TAREFA, tarefaCreateSchema } from "@/lib/schemas/tarefas";
import { createLeadSchema } from "@/lib/schemas/leads";
import { contactCreateSchema } from "@/lib/schemas/contacts";
import { notaCreateSchema } from "@/lib/schemas/fiscal";
import { pedidoCreateSchema } from "@/lib/schemas/pedidos";
import { precoDeVitrine } from "@/lib/schemas/produtos";
import { reais, type AssistenteCtx } from "./contexto";

/**
 * O REGISTRO DE AÇÕES do assistente — o que ele pode EXECUTAR depois do OK.
 *
 * Duas travas, sempre juntas:
 * 1. `schema`: o payload que volta do navegador é revalidado do zero — o que
 *    o modelo montou e o que o usuário confirmou passa pelo MESMO Zod das
 *    rotas. Confiar no payload do client seria dar à IA o poder de inventar
 *    preço: o preço do pedido, por exemplo, é recalculado do catálogo.
 * 2. `piso`: o papel mínimo, ESPELHANDO a rota equivalente (pedido = agent,
 *    nota = agent, tarefa = agent, lead = agent, contato = agent, agenda =
 *    agent). Viewer conversa e consulta, mas a `/executar` o barra aqui.
 *
 * Preços e códigos nunca vêm do payload confirmado: `criar_pedido` resolve de
 * novo código → produto e recalcula tudo do catálogo. O que o usuário viu no
 * resumo é o que executa — ou a execução recusa com o motivo.
 */

const agendarSchema = z.object({
  event_type_id: z.string().uuid(),
  starts_at: z.string().datetime({ offset: true }),
  contact_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * O item da PROPOSTA carrega `codigo` (como o modelo resolveu) junto dos
 * campos do contrato. O Zod padrão REMOVE chave desconhecida em vez de
 * recusar — sem esta extensão, o `codigo` sumiria na validação da `/executar`
 * e a execução falharia dizendo que o produto sumiu. O preço que vem junto é
 * IGNORADO de qualquer jeito: quem precifica é o catálogo (ver executarPedido).
 */
const itemPropostaSchema = z.object({
  codigo: z.string().trim().min(1).max(60),
  quantidade: z.number().int().min(1),
  preco_unit_cents: z.number().int().min(0),
  desconto_pct: z.number().min(0).max(100).optional().default(0),
});

const pedidoPropostaSchema = pedidoCreateSchema.extend({
  itens: z.array(itemPropostaSchema).min(1).max(200),
});

export const ACOES_DO_ASSISTENTE = {
  criar_pedido: { schema: pedidoPropostaSchema, piso: "agent" as Role, recurso: "commercial_orders" },
  emitir_nota: { schema: notaCreateSchema, piso: "agent" as Role, recurso: "invoices" },
  criar_tarefa: { schema: tarefaCreateSchema, piso: "agent" as Role, recurso: "commercial_tasks" },
  criar_lead: { schema: createLeadSchema, piso: "agent" as Role, recurso: "crm_leads" },
  criar_contato: { schema: contactCreateSchema, piso: "agent" as Role, recurso: "contacts" },
  agendar: { schema: agendarSchema, piso: "agent" as Role, recurso: "calendar_appointments" },
} as const;

export type AcaoDoAssistente = keyof typeof ACOES_DO_ASSISTENTE;

export function ehAcaoConhecida(acao: string): acao is AcaoDoAssistente {
  return acao in ACOES_DO_ASSISTENTE;
}

export interface ResultadoDaExecucao {
  mensagem: string;
  link: { rotulo: string; href: string };
}

function numeroPed(numero: number): string {
  return `PED-${String(numero).padStart(4, "0")}`;
}

async function executarPedido(
  ctx: AssistenteCtx,
  payload: z.infer<typeof pedidoPropostaSchema>,
): Promise<ResultadoDaExecucao> {
  // Resolve TUDO de novo: código → produto, preço do catálogo. O preço que
  // veio na proposta é ignorado de propósito — quem precifica é o catálogo,
  // não o navegador.
  const codigos = [...new Set(payload.itens.map((i) => i.codigo))];
  const { data: prods, error } = await ctx.supabase
    .from("catalog_products")
    .select("id, codigo, preco_cents, preco_promocional_cents, promocao_ate")
    .eq("organization_id", ctx.organizationId)
    .eq("ativo", true)
    .in("codigo", codigos);
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao ler o catálogo.");
  const porCodigo = new Map(
    ((prods ?? []) as {
      id: string;
      codigo: string;
      preco_cents: number;
      preco_promocional_cents: number | null;
      promocao_ate: string | null;
    }[]).map((p) => [p.codigo, p]),
  );
  const faltando = codigos.find((c) => !porCodigo.has(c));
  if (faltando) {
    throw new ApiError(422, "validation_failed", undefined, ctx.requestId, `Produto "${faltando}" saiu do catálogo. Monte de novo.`);
  }
  const { itens: _itensProposta, ...resto } = payload;
  void _itensProposta;
  const resultado = await criarPedidoComercial(ctx.supabase, ctx.admin, {
    orgId: ctx.organizationId,
    userId: ctx.userId,
    // O assistente NUNCA ignora trava comercial — sem estoque ou sem crédito,
    // volta recusado e ele explica. Igual à tool de IA do WhatsApp.
    podeIgnorar: false,
  }, {
    ...resto,
    ignorar_estoque: false,
    ignorar_credito: false,
    origem: "assistente",
    itens: payload.itens.map((i) => {
      const p = porCodigo.get(i.codigo)!;
      // MESMO preço de vitrine da proposta (promoção válida vence o base):
      // o que o usuário viu no resumo é o que executa.
      const vitrine = precoDeVitrine(
        {
          preco_cents: p.preco_cents,
          preco_promocional_cents: p.preco_promocional_cents,
          promocao_ate: p.promocao_ate,
        },
        new Date().toISOString().slice(0, 10),
      );
      return {
        product_id: p.id,
        quantidade: i.quantidade,
        preco_unit_cents: vitrine.cents,
        desconto_pct: i.desconto_pct,
      };
    }),
  });
  if (!resultado.ok) {
    const status = resultado.code === "validation_failed" ? 422 : resultado.code === "conflict" ? 409 : 500;
    throw new ApiError(status, resultado.code, undefined, ctx.requestId, resultado.message);
  }
  const ped = resultado.pedido as { id: string; numero: number; total_cents: number };
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "commercial_order.created",
    resourceType: "commercial_orders",
    resourceId: ped.id,
    requestId: ctx.requestId,
  });
  return {
    mensagem: `Pedido ${numeroPed(ped.numero)} criado como rascunho — ${reais(ped.total_cents)}. Um vendedor confere e aprova na tela de pedidos.`,
    link: { rotulo: "Abrir pedidos", href: "/app/pedidos" },
  };
}

async function executarNota(
  ctx: AssistenteCtx,
  payload: z.infer<typeof notaCreateSchema>,
): Promise<ResultadoDaExecucao> {
  const nota = await emitirNota({
    supabase: ctx.supabase,
    admin: ctx.admin,
    orgId: ctx.organizationId,
    userId: ctx.userId,
    requestId: ctx.requestId,
    orderId: payload.order_id,
  });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "invoice.created",
    resourceType: "invoices",
    resourceId: nota.id,
    requestId: ctx.requestId,
  });
  return {
    mensagem: `Nota em emissão (série ${nota.serie}, ${reais(nota.total_cents)}). A SEFAZ responde na fila — acompanhe em Notas.`,
    link: { rotulo: "Abrir notas", href: "/app/notas" },
  };
}

async function executarTarefa(
  ctx: AssistenteCtx,
  payload: z.infer<typeof tarefaCreateSchema>,
): Promise<ResultadoDaExecucao> {
  // Mesmos campos da POST /api/v1/tarefas — uma regra só.
  const { data, error } = await ctx.supabase
    .from("commercial_tasks")
    .insert({
      organization_id: ctx.organizationId,
      titulo: payload.titulo,
      descricao: payload.descricao ?? null,
      tipo: payload.tipo,
      contact_id: payload.contact_id ?? null,
      responsavel_user_id: payload.responsavel_user_id ?? ctx.userId,
      agendada_para: payload.agendada_para ?? null,
      created_by: ctx.userId,
    })
    .select(COLUNAS_DA_TAREFA)
    .single();
  if (error || !data) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Erro ao criar a tarefa.");
  }
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "commercial_task.created",
    resourceType: "commercial_tasks",
    resourceId: (data as unknown as { id: string }).id,
    requestId: ctx.requestId,
  });
  return {
    mensagem: `Tarefa "${payload.titulo}" criada${payload.agendada_para ? ` para ${payload.agendada_para}` : ""}.`,
    link: { rotulo: "Abrir tarefas", href: "/app/tarefas" },
  };
}

async function executarLead(
  ctx: AssistenteCtx,
  payload: z.infer<typeof createLeadSchema>,
): Promise<ResultadoDaExecucao> {
  const lead = await createLeadHandler(
    ctx.supabase,
    { organization_id: ctx.organizationId, actor: { type: "user", id: ctx.userId }, requestId: ctx.requestId },
    payload,
  );
  const id = (lead as unknown as { id: string }).id;
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "lead.created",
    resourceType: "crm_leads",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return {
    mensagem: `Negócio "${payload.title}" criado no funil.`,
    link: { rotulo: "Abrir funil", href: "/app/kanban" },
  };
}

async function executarContato(
  ctx: AssistenteCtx,
  payload: z.infer<typeof contactCreateSchema>,
): Promise<ResultadoDaExecucao> {
  const result = await createContactHandler(
    ctx.supabase,
    { organization_id: ctx.organizationId, actor: { type: "user", id: ctx.userId }, requestId: ctx.requestId },
    payload,
  );
  const contato = result as unknown as { id: string; display_name?: string; name?: string };
  return {
    mensagem: `Cliente "${contato.display_name ?? contato.name ?? "novo cliente"}" cadastrado. Já dá para montar pedido para ele.`,
    link: { rotulo: "Abrir contatos", href: "/app/contacts" },
  };
}

async function executarAgendamento(
  ctx: AssistenteCtx,
  payload: z.infer<typeof agendarSchema>,
): Promise<ResultadoDaExecucao> {
  const r = await marcarAgendamentoHandler(
    ctx.supabase,
    { organization_id: ctx.organizationId, actor: { type: "user", id: ctx.userId }, requestId: ctx.requestId },
    {
      event_type_id: payload.event_type_id,
      starts_at: payload.starts_at,
      ...(payload.contact_id ? { contact_id: payload.contact_id } : {}),
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.notes ? { notes: payload.notes } : {}),
    },
  );
  void r;
  return {
    mensagem: `Compromisso marcado para ${payload.starts_at.slice(0, 10)} às ${payload.starts_at.slice(11, 16)}.`,
    link: { rotulo: "Abrir agenda", href: "/app/agenda" },
  };
}

/** Executa UMA ação confirmada. Quem chama já barrou o papel (`piso`). */
export async function executarProposta(
  ctx: AssistenteCtx,
  acao: AcaoDoAssistente,
  payload: unknown,
): Promise<ResultadoDaExecucao> {
  // O parse é POR AÇÃO (não no union do registro): assim o `parsed.data` de
  // cada ramo tem o tipo exato do executor, em vez do último schema do union.
  switch (acao) {
    case "criar_pedido": {
      const parsed = ACOES_DO_ASSISTENTE.criar_pedido.schema.safeParse(payload);
      if (!parsed.success) throw propostaMudou(ctx);
      return executarPedido(ctx, parsed.data);
    }
    case "emitir_nota": {
      const parsed = ACOES_DO_ASSISTENTE.emitir_nota.schema.safeParse(payload);
      if (!parsed.success) throw propostaMudou(ctx);
      return executarNota(ctx, parsed.data);
    }
    case "criar_tarefa": {
      const parsed = ACOES_DO_ASSISTENTE.criar_tarefa.schema.safeParse(payload);
      if (!parsed.success) throw propostaMudou(ctx);
      return executarTarefa(ctx, parsed.data);
    }
    case "criar_lead": {
      const parsed = ACOES_DO_ASSISTENTE.criar_lead.schema.safeParse(payload);
      if (!parsed.success) throw propostaMudou(ctx);
      return executarLead(ctx, parsed.data);
    }
    case "criar_contato": {
      const parsed = ACOES_DO_ASSISTENTE.criar_contato.schema.safeParse(payload);
      if (!parsed.success) throw propostaMudou(ctx);
      return executarContato(ctx, parsed.data);
    }
    case "agendar": {
      const parsed = ACOES_DO_ASSISTENTE.agendar.schema.safeParse(payload);
      if (!parsed.success) throw propostaMudou(ctx);
      return executarAgendamento(ctx, parsed.data);
    }
  }
}

function propostaMudou(ctx: AssistenteCtx): ApiError {
  return new ApiError(422, "validation_failed", undefined, ctx.requestId, "A proposta mudou no caminho. Monte de novo.");
}
