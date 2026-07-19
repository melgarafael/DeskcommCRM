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
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
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

  const { data: members, error: mErr } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", activeOrg.orgId)
    .is("revoked_at", null);
  if (mErr) return fail("internal_error", mErr.message, 500, { requestId });

  // Atendentes = agent+ (viewer não é insumo de roteamento).
  const attendants = (members ?? []).filter(
    (m) => ROLE_RANK[m.role as Role] >= ROLE_RANK.agent,
  ) as Array<{ user_id: string; role: Role }>;
  const userIds = attendants.map((m) => m.user_id);
  if (userIds.length === 0) return ok([], { requestId });

  const { data: availData, error: aErr } = await admin
    .from("attendant_availability")
    .select(SELECT_COLS)
    .eq("organization_id", activeOrg.orgId)
    .in("user_id", userIds);
  if (aErr) return fail("internal_error", aErr.message, 500, { requestId });
  const availByUser = new Map(
    ((availData ?? []) as AvailabilityRow[]).map((a) => [a.user_id, a] as const),
  );

  // Carga atual = conversas abertas atribuídas, contadas org-wide (mesma
  // definição do worker de roteamento).
  const { data: openConvs, error: loadErr } = await admin
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", activeOrg.orgId)
    .in("assigned_to_user_id", userIds)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[]);
  if (loadErr) return fail("internal_error", loadErr.message, 500, { requestId });
  const loadByUser = new Map<string, number>();
  for (const c of (openConvs ?? []) as Array<{ assigned_to_user_id: string | null }>) {
    if (c.assigned_to_user_id) {
      loadByUser.set(c.assigned_to_user_id, (loadByUser.get(c.assigned_to_user_id) ?? 0) + 1);
    }
  }

  // Nome/email por atendente (mesmo padrão de /api/v1/metrics/attendants).
  const names = new Map<string, { name: string | null; email: string | null }>();
  await Promise.all(
    userIds.map(async (id) => {
      const { data: userRes } = await admin.auth.admin.getUserById(id);
      const u = userRes?.user;
      names.set(id, {
        name: (u?.user_metadata?.full_name as string | undefined) ?? null,
        email: u?.email ?? null,
      });
    }),
  );

  const rows = attendants.map((m) => {
    const a = availByUser.get(m.user_id);
    return {
      user_id: m.user_id,
      role: m.role,
      name: names.get(m.user_id)?.name ?? null,
      email: names.get(m.user_id)?.email ?? null,
      is_available: a?.is_available ?? false,
      capacity: a?.capacity ?? null,
      schedule: a?.schedule ?? { timezone: "America/Sao_Paulo", windows: [] },
      last_heartbeat_at: a?.last_heartbeat_at ?? null,
      updated_at: a?.updated_at ?? null,
      current_load: loadByUser.get(m.user_id) ?? 0,
    };
  });

  return ok(rows, { requestId });
}
