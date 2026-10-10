/**
 * Cancelar uma janela de manutenção (#2388).
 *
 * Cancelar é mudar o ESTADO da linha para `cancelled`, e nada mais: o cron não
 * lê mais aquela agenda, então a retomada programada some junto (o que a
 * janela já pausou permanece pausado — quem quer voltar ao ar usa a pausa
 * manual em Conexões, que é a mesma escrita e o mesmo botão de sempre).
 *
 * Idempotência é obrigatória aqui, não enfeite: "cancelar duas vezes" é uma
 * pergunta sem resposta ("já cancelada" não é erro para quem clica de novo),
 * enquanto uma janela que já terminou recebe 409 dizendo isso — cancelar o
 * passado não desfaz nada.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_schedules",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  // Depois do papel: sem ele, 403; com ele, id que não é uuid é janela que não
  // existe (404), e não o 500 do Postgres (22P02).
  if (!z.uuid().safeParse(id).success) return fail("not_found", "Janela não encontrada.", 404, { requestId });
  const db = createAdminClient();

  const { data: agenda, error } = await db
    .from("channel_schedules")
    .select("id, status")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar a janela.", 500, { requestId });
  if (!agenda) return fail("not_found", "Janela não encontrada.", 404, { requestId });

  const statusAtual = (agenda as { status: string }).status;
  if (statusAtual === "cancelled") {
    return ok({ id, status: "cancelled", mudou: false }, { requestId });
  }
  if (statusAtual === "done") {
    return fail("conflict", "Esta janela já terminou — cancelar não desfaz o que ela fez.", 409, { requestId });
  }

  // O filtro de status é a trava de duas mãos: uma corrida com outra corrida
  // (ou com o próprio cron) não aplica duas vezes; só uma "ganha" a linha.
  const { data, error: erroUpdate } = await db
    .from("channel_schedules")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .in("status", ["scheduled", "running"])
    .select("id");
  if (erroUpdate) return fail("internal_error", "Não foi possível cancelar a janela.", 500, { requestId });
  const mudou = ((data ?? []) as Array<{ id: string }>).length > 0;
  if (mudou) {
    void audit({
      action: "channel.schedule_cancelled",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "channel_schedule",
      resourceId: id,
      requestId,
      metadata: { status_anterior: statusAtual },
    });
  }

  return ok({ id, status: "cancelled", mudou }, { requestId });
}
