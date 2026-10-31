import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/attendants/sectors — setores de atendimento da org (qualquer membro).
 * POST /api/v1/attendants/sectors — cria um setor (manager+).
 *
 * A leitura dos setores vai pelo client da sessão: a RLS de `attendant_sectors`
 * é org-wide (migration 0801). O contador `member_count` conta só filiação
 * ativa e por isso lê vínculos e filiações pelo admin client. A escrita vai pelo admin client, porque a tabela
 * não concede escrita a `authenticated` — então a org vem de fonte confiável
 * (activeOrg do cookie) e é filtrada à mão, nunca lida do corpo.
 *
 * Nome repetido na mesma org (índice `attendant_sectors_org_name_unique`) é
 * 409 `sector_name_taken`: é a idempotência natural da criação — repetir o
 * POST não cria um segundo "Suporte".
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { sectorCreateSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SELECT_COLS = "id, name, description, created_at, updated_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("viewer", { requestId, resource: "attendant_sectors" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  // O contador usa a MESMA régua do roster da aba Atendimento
  // (`carregarRosterDeAtendimento`): filiação ATIVA (`revoked_at is null`) e
  // papel agent+. Revogar ou rebaixar a viewer não apaga o vínculo (só apagar a
  // filiação apaga, pela FK), e sem as duas condições o setor contaria quem a
  // aba Atendimento já não mostra. A RLS de user_organizations mostra a
  // manager/viewer só a própria linha, então a filiação ativa é lida pelo admin
  // client, com a org de fonte confiável (activeOrg do cookie) filtrada à mão.
  const supabase = await createClient();
  const admin = createAdminClient();
  const [sectors, members, active] = await Promise.all([
    supabase.from("attendant_sectors").select(SELECT_COLS)
      .eq("organization_id", orgId).order("name", { ascending: true }),
    admin.from("attendant_sector_members").select("sector_id, user_id")
      .eq("organization_id", orgId),
    admin.from("user_organizations").select("user_id, role")
      .eq("organization_id", orgId).is("revoked_at", null),
  ]);
  if (sectors.error) return fail("internal_error", sectors.error.message, 500, { requestId });
  if (members.error) return fail("internal_error", members.error.message, 500, { requestId });
  if (active.error) return fail("internal_error", active.error.message, 500, { requestId });

  const activeUserIds = new Set(
    ((active.data ?? []) as Array<{ user_id: string; role: Role }>)
      .filter((a) => roleAtLeast(a.role, "agent"))
      .map((a) => a.user_id),
  );
  const countBySector = new Map<string, number>();
  for (const m of members.data ?? []) {
    if (!activeUserIds.has(m.user_id)) continue;
    countBySector.set(m.sector_id, (countBySector.get(m.sector_id) ?? 0) + 1);
  }

  return ok(
    (sectors.data ?? []).map((s) => ({ ...s, member_count: countBySector.get(s.id) ?? 0 })),
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("manager", { requestId, resource: "attendant_sectors" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let input;
  try {
    input = await validateRequest(sectorCreateSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("attendant_sectors")
    .insert({ organization_id: authz.org.orgId, name: input.name, description: input.description })
    .select(SELECT_COLS)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("sector_name_taken", t("Já existe um setor com este nome."), 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "attendant.sector_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "attendant_sectors",
    resourceId: row.id,
    requestId,
    bypassedRls: true,
    metadata: { name: row.name },
  });

  return ok({ ...row, member_count: 0 }, { requestId, status: 201 });
}
