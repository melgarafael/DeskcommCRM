/**
 * /api/v1/channel-schedules — agendar (e listar) a janela de manutenção (#2388).
 *
 * ─── O que a janela é, e o que ela NÃO é ────────────────────────────────────
 *
 * Um registro com autor, horário de início e fim, escopo (um canal ou a
 * organização inteira) e estado. Ela NÃO pausa ninguém aqui: quem pausa e quem
 * retoma é o cron `channel-pause-scheduler`, pela MESMA escrita da pausa manual
 * (`fn_definir_pausa_de_canal`, a peça da qual `fn_definir_canal_desativado`
 * delega). Guardar a intenção em uma linha — e não acionar na hora — é o que
 * permite a retomada automática existir: quem agenda vai dormir.
 *
 * ─── Por que o horário vira instante AQUI e não lá ───────────────────────────
 *
 * A tela manda hora de PAREDE no fuso DA ORGANIZAÇÃO ("das 23h às 2h" é o que
 * o operador quer dizer); a conversão para instante absoluto acontece nesta
 * fronteira, com `organizations.timezone` lido do banco — nunca com o fuso do
 * navegador nem com UTC fixo. Assim a janela atravessa a virada de horário de
 * verão certa dos dois lados (critério 7) e o cron compara instantes, sem
 * saber o que é fuso.
 *
 * ─── Recusas com mensagem clara (critério 4) ─────────────────────────────────
 *
 * Janela no passado, fim antes do início e janela maior que 24h são recusadas
 * com a frase dizendo o que fazer — nunca um "validation failed" seco.
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

/** Uma janela de manutenção não vira plano: acima de 24h é outra coisa. */
const DURACAO_MAXIMA_MS = 24 * 60 * 60 * 1000;

const criarSchema = z
  .object({
    starts_at: z.string().min(1),
    ends_at: z.string().min(1),
    channel_session_id: z.uuid().nullish(),
  })
  .strict();

export type AgendaLinha = {
  id: string;
  organization_id: string;
  channel_session_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  paused_channel_ids: string[] | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const COLUNAS =
  "id, organization_id, channel_session_id, starts_at, ends_at, status, paused_channel_ids, created_by, created_at, updated_at";

/** Cria a janela. Nada pausa agora — o cron aplica na hora marcada. */
export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_schedules",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const parsed = criarSchema.safeParse(await req.json().catch(() => null));
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
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    return fail("validation_failed", "Horário inválido: use o formato ISO com fuso.", 422, { requestId });
  }
  if (fim.getTime() <= inicio.getTime()) {
    return fail(
      "validation_failed",
      "A janela termina antes de começar: escolha um fim depois do início.",
      422,
      { requestId },
    );
  }
  if (fim.getTime() - inicio.getTime() > DURACAO_MAXIMA_MS) {
    return fail(
      "validation_failed",
      "A janela de manutenção não pode durar mais de 24h: para uma pausa longa, faça a pausa manual em Conexões e desfaça quando voltar.",
      422,
      { requestId },
    );
  }
  if (inicio.getTime() <= Date.now()) {
    return fail(
      "validation_failed",
      "A janela precisa começar no futuro. Para pausar agora, use a pausa manual em Conexões — esta janela é para quando você puder ir dormir.",
      422,
      { requestId },
    );
  }

  const db = createAdminClient();
  const canal = parsed.data.channel_session_id ?? null;
  if (canal) {
    const { data: existe, error: erroCanal } = await db
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", auth.org.orgId)
      .eq("id", canal)
      .is("archived_at", null)
      .maybeSingle();
    if (erroCanal) return fail("internal_error", "Não foi possível conferir o canal.", 500, { requestId });
    if (!existe) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  }

  const { data, error } = await db
    .from("channel_schedules")
    .insert({
      organization_id: auth.org.orgId,
      channel_session_id: canal,
      starts_at: inicio.toISOString(),
      ends_at: fim.toISOString(),
      status: "scheduled",
      created_by: auth.user.id,
    })
    .select(COLUNAS)
    .maybeSingle();
  if (error || !data) {
    return fail("internal_error", "Não foi possível salvar a janela. Verifique se o banco está atualizado.", 500, { requestId });
  }

  // Quem agendou fica NA LINHA (`created_by`) e na trilha, como toda mutação.
  const agenda = data as AgendaLinha;
  void audit({
    action: "channel.schedule_created",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_schedule",
    resourceId: agenda.id,
    requestId,
    metadata: { starts_at: agenda.starts_at, ends_at: agenda.ends_at, channel_session_id: canal },
  });
  return ok({ agenda }, { requestId });
}

/** Lista as janelas da organização, da mais recente para a mais antiga. */
export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_schedules",
    allowPlatformAdmin: "leitura",
  });
  if (!auth.ok) return auth.response;

  const db = createAdminClient();
  const [agenda, org] = await Promise.all([
    db
      .from("channel_schedules")
      .select(COLUNAS)
      .eq("organization_id", auth.org.orgId)
      .order("starts_at", { ascending: false })
      .limit(100),
    db.from("organizations").select("timezone").eq("id", auth.org.orgId).maybeSingle(),
  ]);
  if (agenda.error) return fail("internal_error", "Não foi possível carregar as janelas.", 500, { requestId });

  return ok(
    {
      // O fuso vem do BANCO, não do navegador: a tela monta o instante com ele
      // (lib/agenda/fuso) e o servidor guarda instante absoluto.
      fuso: (org.data as { timezone: string } | null)?.timezone ?? "America/Sao_Paulo",
      agendas: (agenda.data ?? []) as AgendaLinha[],
    },
    { requestId },
  );
}
