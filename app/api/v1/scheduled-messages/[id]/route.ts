/**
 * GET    /api/v1/scheduled-messages/[id] — o pacote com as partes.
 * PATCH  /api/v1/scheduled-messages/[id] — muda hora/fuso/partes (só `scheduled`).
 * DELETE /api/v1/scheduled-messages/[id] — desmarca (só `scheduled`).
 *
 * A régua de "quem pode ser editado/cancelado" é `podeEditar`/`podeCancelar` de
 * `lib/mensagem-agendada/regras.ts` — a MESMA que o MCP lê. Não há segunda
 * condição escrita aqui: uma lista por superfície diverge na primeira correção.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  cancelaMensagemAgendadaNoCrm,
  editaMensagemAgendadaNoCrm,
  leMensagemAgendadaNoCrm,
  type RecusaDaOperacao,
} from "@/lib/mensagem-agendada/crm";
import { editarMensagemSchema } from "@/lib/schemas/mensagem-agendada";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

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

type Contexto = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, contexto: Contexto): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id } = await contexto.params;

  const resultado = await leMensagemAgendadaNoCrm(
    { admin: createAdminClient(), orgId: authz.org.orgId },
    id,
  );
  if (!resultado.ok) {
    return fail(
      resultado.codigo,
      resultado.mensagem,
      statusDaRecusa(resultado.codigo),
      { requestId },
    );
  }
  return ok(resultado.pacote, { requestId });
}

export async function PATCH(req: NextRequest, contexto: Contexto): Promise<Response> {
  // Mesma guarda de efeito do POST: mudar a hora marcada é escrita.
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id } = await contexto.params;

  const raw = await req.json().catch(() => null);
  const parsed = editarMensagemSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const resultado = await editaMensagemAgendadaNoCrm(
    {
      admin: createAdminClient(),
      orgId: authz.org.orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
      source: "inbox",
    },
    id,
    parsed.data,
  );
  if (!resultado.ok) {
    return fail(resultado.codigo, resultado.mensagem, statusDaRecusa(resultado.codigo), {
      requestId,
    });
  }
  return ok(resultado.pacote, { requestId });
}

export async function DELETE(req: NextRequest, contexto: Contexto): Promise<Response> {
  // Desmarcar é escrita, e é a que mais pesa em somente-leitura: pacote
  // cancelado não volta.
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id } = await contexto.params;

  // Motivo opcional: a tela manda `?motivo=...`; ausente, o texto é o de gente.
  const motivo = new URL(req.url).searchParams.get("motivo")?.trim();
  const resultado = await cancelaMensagemAgendadaNoCrm(
    {
      admin: createAdminClient(),
      orgId: authz.org.orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
      source: "inbox",
    },
    id,
    motivo !== undefined && motivo !== "" ? motivo.slice(0, 200) : "Cancelada pelo operador",
  );
  if (!resultado.ok) {
    return fail(resultado.codigo, resultado.mensagem, statusDaRecusa(resultado.codigo), {
      requestId,
    });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "scheduled_message.cancelled",
    resourceType: "scheduled_messages",
    resourceId: id,
    requestId,
    metadata: { motivo: resultado.pacote.cancel_reason },
  });
  return ok(resultado.pacote, { requestId });
}
