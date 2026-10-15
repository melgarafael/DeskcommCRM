/**
 * Editar e cancelar uma janela de manutenção (#2388).
 *
 * Editar (PATCH) muda os dois horários de uma janela que ainda não começou —
 * quem agenda cedo e percebe que errou a hora corrige em vez de cancelar e
 * recriar. Cancelar (DELETE) é mudar o ESTADO da linha para `cancelled`, e nada
 * mais: o cron não lê mais aquela agenda, então a retomada programada some
 * junto (o que a janela já pausou permanece pausado — quem quer voltar ao ar usa
 * a pausa manual em Conexões, que é a mesma escrita e o mesmo botão de sempre).
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
import { validarJanela } from "../route";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * O que o operador PODE mudar numa janela agendada: os dois horários.
 *
 * O escopo (um canal × todas) fica de fora de propósito nesta entrega: trocá-lo
 * de "um canal" para "todas" muda quem a janela alcança, e uma janela em
 * andamento já pausou gente — editar o escopo dela é outra decisão, não a
 * correção de horário que este PATCH resolve. Declarado no PR.
 */
const editarSchema = z
  .object({
    starts_at: z.string().min(1),
    ends_at: z.string().min(1),
  })
  .strict();

/**
 * Editar uma janela que AINDA NÃO começou (#2388).
 *
 * Só `scheduled` é editável: uma janela em andamento já pausou canais (o
 * relógio a aplicou), e uma encerrada é passado — mudar o horário de qualquer
 * uma das duas seria reescrever o que aconteceu. O cron lê o horário NOVO na
 * batida seguinte porque ele lê a LINHA a cada acorde, não guarda instante: a
 * edição não precisa empurrar nada para o agendador.
 */
export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
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
  if (!z.uuid().safeParse(id).success) return fail("not_found", "Janela não encontrada.", 404, { requestId });

  const parsed = editarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      "Informe os horários da janela: starts_at e ends_at, com timezone.",
      422,
      { requestId },
    );
  }

  const inicio = new Date(parsed.data.starts_at);
  const fim = new Date(parsed.data.ends_at);
  const recusa = validarJanela(inicio, fim);
  if (recusa) return fail("validation_failed", recusa, 422, { requestId });

  const db = createAdminClient();
  const { data: atual, error } = await db
    .from("channel_schedules")
    .select("id, status")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar a janela.", 500, { requestId });
  if (!atual) return fail("not_found", "Janela não encontrada.", 404, { requestId });

  const statusAtual = (atual as { status: string }).status;
  if (statusAtual !== "scheduled") {
    return fail(
      "conflict",
      "Só dá para editar uma janela que ainda não começou — uma janela em andamento já pausou conexões, e uma encerrada é passado.",
      409,
      { requestId },
    );
  }

  // O filtro de status é a trava: uma corrida com o próprio cron (que virou a
  // janela para `running` no minuto em que ela abriu) perde o claim e recebe
  // 409 em vez de reescrever um horário que já está sendo cumprido.
  const { data, error: erroUpdate } = await db
    .from("channel_schedules")
    .update({
      starts_at: inicio.toISOString(),
      ends_at: fim.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .eq("status", "scheduled")
    .select("id, starts_at, ends_at, status");
  if (erroUpdate) return fail("internal_error", "Não foi possível salvar a janela.", 500, { requestId });

  const mudou = ((data ?? []) as Array<{ id: string }>).length > 0;
  if (!mudou) {
    return fail(
      "conflict",
      "A janela mudou de estado enquanto você editava — recarregue para ver o estado atual.",
      409,
      { requestId },
    );
  }

  void audit({
    action: "channel.schedule_updated",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_schedule",
    resourceId: id,
    requestId,
    metadata: { starts_at: inicio.toISOString(), ends_at: fim.toISOString() },
  });

  return ok({ id, starts_at: inicio.toISOString(), ends_at: fim.toISOString(), mudou: true }, { requestId });
}

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
