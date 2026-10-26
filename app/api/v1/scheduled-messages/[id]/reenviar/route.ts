/**
 * POST /api/v1/scheduled-messages/[id]/reenviar — "reenviar o que faltou".
 *
 * Só pacote `partial`/`failed` e só as partes `failed`/`skipped`; o resto já
 * chegou. Nasce um pacote NOVO (`original_id` aponta para o que falhou), com
 * `internal_message_id` novos: é envio novo, decidido por alguém agora — reusar
 * o id antigo faria o handler encontrar a mensagem que falhou e recusar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { reenviaOQueFaltouNoCrm, type RecusaDaOperacao } from "@/lib/mensagem-agendada/crm";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const STATUS_DA_RECUSA: Record<string, number> = {
  pacote_nao_encontrado: 404,
  ja_encerrado: 409,
  sem_partes: 422,
  partes_demais: 422,
  parte_vazia: 422,
  corpo_longo_demais: 422,
  instante_no_passado: 422,
  fuso_invalido: 422,
  falha_ao_gravar: 500,
};

type Contexto = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, contexto: Contexto): Promise<Response> {
  // Reenviar cria um pacote NOVO (e um cron novo): é escrita como qualquer outra.
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id } = await contexto.params;

  const resultado = await reenviaOQueFaltouNoCrm(
    {
      admin: createAdminClient(),
      orgId: authz.org.orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
      source: "inbox",
    },
    id,
  );
  if (!resultado.ok) {
    const codigo: RecusaDaOperacao | string = resultado.codigo;
    return fail(codigo, resultado.mensagem, STATUS_DA_RECUSA[codigo] ?? 400, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "scheduled_message.resent",
    resourceType: "scheduled_messages",
    resourceId: resultado.pacote.id,
    requestId,
    metadata: { original_id: id, partes: resultado.pacote.parts.length },
  });
  return ok(resultado.pacote, { requestId, status: 201 });
}
