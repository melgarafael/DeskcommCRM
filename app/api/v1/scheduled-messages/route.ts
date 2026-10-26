/**
 * GET  /api/v1/scheduled-messages — os agendamentos da conversa/contato.
 * POST /api/v1/scheduled-messages — agenda um pacote para a hora marcada.
 *
 * ─── Por que uma rota própria, e não `POST /messages` com `scheduled_for` ───
 *
 * O envio manual publica um balão AGORA e a automação cria um job de turno
 * (`followup_turn`), em que a IA reescreve. O pacote agendado é terceira coisa:
 * texto fixo, várias partes, hora absoluta, cancela se o contato responder. Uma
 * rota com nome próprio deixa isso explícito para a tela, para o token e para o
 * MCP — que precisam da mesma operação — e permite listar/cancelar/editar sem
 * fingir que é mensagem já enviada.
 *
 * `service_role` de propósito na gravação: o cron (`cron_jobs`) nasce no mesmo
 * gesto e não tem policy de insert para humano. A organização vem SEMPRE do JWT
 * (`org.orgId`), nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  agendaMensagemNoCrm,
  listaMensagensAgendadasNoCrm,
  type PacoteGravado,
  type RecusaDaOperacao,
} from "@/lib/mensagem-agendada/crm";
import { motivoLegivel } from "@/lib/mensagem-agendada/regras";
import { agendarMensagemSchema } from "@/lib/schemas/mensagem-agendada";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /api/v1/scheduled-messages";

/** Recusa de negócio → status HTTP. `404` é o "não existe nesta org". */
const STATUS_DA_RECUSA: Record<string, number> = {
  sem_conversa: 422,
  sem_partes: 422,
  partes_demais: 422,
  parte_vazia: 422,
  corpo_longo_demais: 422,
  instante_invalido: 422,
  instante_no_passado: 422,
  instante_longe_demais: 422,
  fuso_invalido: 422,
  conversa_nao_encontrada: 404,
  pacote_nao_encontrado: 404,
  ja_encerrado: 409,
  parte_com_anexo_ausente: 422,
  falha_ao_gravar: 500,
};

function statusDaRecusa(codigo: RecusaDaOperacao | string): number {
  return STATUS_DA_RECUSA[codigo] ?? 400;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limiteBruto = Number(url.searchParams.get("limite") ?? "50");

  const resultado = await listaMensagensAgendadasNoCrm(
    {
      admin: createAdminClient(),
      orgId: org.orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
      source: "inbox",
    },
    {
      conversation_id: url.searchParams.get("conversation_id"),
      contact_id: url.searchParams.get("contact_id"),
      // Valor fora do vocabulário vira "sem filtro" em vez de 500: a tela manda
      // `status=` enquanto o usuário digita.
      status: status === null || status === "" ? null : (status as never),
      limite: Number.isFinite(limiteBruto) ? limiteBruto : 50,
    },
  );

  if (!resultado.ok) {
    return fail("internal_error", "Erro ao listar mensagens agendadas.", 500, { requestId });
  }
  return ok(resultado.pacotes, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  // Guarda de EFEITO do suporte (#3118): em `support_readonly` a rota não grava
  // nem agenda — e vem antes do RBAC porque a trava do suporte é mais larga que o
  // papel: quem está em somente-leitura não precisa nem chegar à checagem de role.
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const raw = await req.json().catch(() => null);
  const parsed = agendarMensagemSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const admin = createAdminClient();
  const deps = {
    admin,
    orgId: org.orgId,
    actor: { type: "user" as const, id: authz.user.id },
    requestId,
    source: "inbox" as const,
  };

  /**
   * O tipo da resposta é escrito à mão, e não deixado para a inferência.
   *
   * `comIdempotencia` é genérico em `T`, e `executar` devolve uma UNIÃO
   * (`pacote` ou `{ erro, mensagem }`). Com dois ramos, o TypeScript infere `T`
   * do primeiro e recusa o segundo — o erro aparece longe daqui, na chamada. Uma
   * união nomeada faz o genérico resolver para ela, que é o que a rota já
   * devolve de fato.
   */
  type RespostaDoAgendamento = PacoteGravado | { erro: RecusaDaOperacao; mensagem: string };
  const executar = async (): Promise<{ resposta: RespostaDoAgendamento; status: number }> => {
    const criado = await agendaMensagemNoCrm(deps, parsed.data);
    if (!criado.ok) {
      return {
        resposta: { erro: criado.codigo, mensagem: criado.mensagem },
        status: statusDaRecusa(criado.codigo),
      };
    }
    await audit({
      organizationId: org.orgId,
      actorUserId: authz.user.id,
      action: "scheduled_message.created",
      resourceType: "scheduled_messages",
      resourceId: criado.pacote.id,
      requestId,
      metadata: {
        scheduled_for: criado.pacote.scheduled_for,
        partes: criado.pacote.parts.length,
        cancel_if_contact_replies: criado.pacote.cancel_if_contact_replies,
      },
    });
    return { resposta: criado.pacote, status: 201 };
  };

  const desfecho =
    chave === null
      ? { tipo: "executou" as const, ...(await executar()) }
      : await comIdempotencia({
          db: admin,
          organizationId: org.orgId,
          endpoint: ENDPOINT,
          chave,
          corpo: parsed.data,
          executar,
        });

  if (desfecho.tipo === "conflito") {
    return fail("idempotency_conflict", "Esta chave já foi usada com outro conteúdo.", 409, {
      requestId,
    });
  }
  if (desfecho.tipo === "em_curso") {
    return fail("idempotency_in_progress", "A mesma requisição está em curso.", 409, { requestId });
  }

  const corpo = desfecho.resposta as { erro?: string; mensagem?: string };
  if (desfecho.status >= 400 && corpo.erro !== undefined) {
    return fail(corpo.erro, corpo.mensagem ?? motivoLegivel(corpo.erro), desfecho.status, {
      requestId,
    });
  }
  // `OkOptions.status` é literal (`200 | 201 | 204`); a união que vem do
  // idempotente é `number`. O único sucesso possível aqui é a criação (201) ou o
  // replay da MESMA chave (200) — qualquer coisa fora disso já voltou por `fail`
  // acima.
  return ok(desfecho.resposta, { requestId, status: desfecho.status === 201 ? 201 : 200 });
}
