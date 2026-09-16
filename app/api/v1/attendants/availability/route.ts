/**
 * GET /api/v1/attendants/availability — roster de atendimento da org (org-wide).
 *
 * Visível a agent+ (matriz spec 13 §4 nota 5: a disponibilidade da equipe é
 * insumo operacional do roteamento — quem está online / com folga / com quanta
 * carga). Retorna UMA linha por membro agent+ da org (LEFT JOIN availability),
 * com nome/carga — o painel de gestão (G5-04) consome só este endpoint.
 *
 * Por que service role + filtro manual de org (doutrina): a RLS de
 * user_organizations restringe manager a ver só a PRÓPRIA linha (só admin vê o
 * roster inteiro), então listar a equipe pelo client user-scoped devolveria 1
 * linha. O admin client resolve a org de fonte confiável (activeOrg do cookie) e
 * filtra organization_id manualmente. Degrada (availability-only, sem nomes)
 * quando o service role não está configurado (dev), como o /api/v1/team faz.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { carregarRosterDeAtendimento } from "@/lib/escalacao/atendentes";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "user_id, is_available, capacity, schedule, last_heartbeat_at, updated_at";

interface AvailabilityRow {
  user_id: string;
  is_available: boolean;
  capacity: number;
  schedule: unknown;
  last_heartbeat_at: string | null;
  updated_at: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "attendant_availability" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  // Dev sem service role: devolve só as linhas de availability (org-wide via RLS
  // própria da tabela), sem roster completo nem nomes.
  if (!isServiceRoleConfigured()) {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("attendant_availability")
      .select(SELECT_COLS)
      .eq("organization_id", activeOrg.orgId);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    const rows = (data ?? []) as AvailabilityRow[];
    return ok(
      rows.map((r) => ({ ...r, role: null, name: null, email: null, current_load: 0 })),
      { requestId },
    );
  }

  const admin = createAdminClient();

  // O roster + a carga vivem em lib/escalacao/atendentes.ts porque a capacidade
  // do agente ("quem pode assumir agora?") lê exatamente a mesma coisa. Enquanto
  // a regra morou aqui dentro, o agente escalava para uma fila cega.
  let roster;
  try {
    roster = await carregarRosterDeAtendimento(admin, activeOrg.orgId);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "roster", 500, {
      requestId,
    });
  }
  if (roster.length === 0) return ok([], { requestId });

  // Nome/email por atendente (mesmo padrão de /api/v1/metrics/attendants). Fica
  // NA ROTA, não na função compartilhada: e-mail é PII e a superfície do agente
  // não recebe e-mail nem telefone de atendente.
  const names = new Map<string, { name: string | null; email: string | null }>();
  await Promise.all(
    roster.map(async ({ userId }) => {
      const { data: userRes } = await admin.auth.admin.getUserById(userId);
      const u = userRes?.user;
      names.set(userId, {
        name: (u?.user_metadata?.full_name as string | undefined) ?? null,
        email: u?.email ?? null,
      });
    }),
  );

  const rows = roster.map((m) => ({
    user_id: m.userId,
    role: m.papel,
    name: names.get(m.userId)?.name ?? null,
    email: names.get(m.userId)?.email ?? null,
    is_available: m.disponivel,
    capacity: m.capacidade,
    schedule: m.agenda,
    last_heartbeat_at: m.ultimoSinalDeVida,
    updated_at: m.atualizadoEm,
    current_load: m.cargaAtual,
  }));

  return ok(rows, { requestId });
}
