import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/attendants/sectors — setores de atendimento da org (qualquer membro).
 * POST /api/v1/attendants/sectors — cria um setor (manager+).
 *
 * A leitura dos setores vai pelo client do portão (`authz.supabase`: o da sessão,
 * com a RLS org-wide de `attendant_sectors`, migration 0801; no token, o admin,
 * e o filtro de organização à mão é a única barreira). O contador `member_count` conta só filiação
 * ativa e por isso lê vínculos e filiações pelo admin client. A escrita vai pelo admin client, porque a tabela
 * não concede escrita a `authenticated` — então a org vem de fonte confiável
 * (activeOrg do cookie) e é filtrada à mão, nunca lida do corpo.
 *
 * Nome repetido na mesma org (índice `attendant_sectors_org_name_unique`) é
 * 409 `sector_name_taken`: é a idempotência natural da criação — repetir o
 * POST não cria um segundo "Suporte".
 *
 * Aceitam sessão de navegador OU Bearer `dsk_…` (`config:read` no GET,
 * `config:write` no POST; papel admin via `tokenRole`). A organização vem do
 * portão, nunca do corpo. No token o `actorUserId` do audit é nulo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { sectorCreateSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

const SELECT_COLS = "id, name, description, schedule, color, created_at, updated_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "attendant_sectors",
    role: "viewer",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "attendant_sectors", requestId);
  if (teto) return teto;
  const orgId = authz.organizationId;

  // O contador usa a MESMA régua do roster da aba Atendimento
  // (`carregarRosterDeAtendimento`): filiação ATIVA (`revoked_at is null`) e
  // papel agent+. Revogar ou rebaixar a viewer não apaga o vínculo (só apagar a
  // filiação apaga, pela FK), e sem as duas condições o setor contaria quem a
  // aba Atendimento já não mostra. A RLS de user_organizations mostra a
  // manager/viewer só a própria linha, então a filiação ativa é lida pelo admin
  // client, com a org de fonte confiável (activeOrg do cookie) filtrada à mão.
  const supabase = authz.supabase;
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
  // (9062) N filas por atendente: a lista de ids vem junto do contador, porque a
  // tela de membros da fila precisa saber QUEM já está nela — antes, um
  // atendente só podia estar num setor e isso não precisava ser dito.
  for (const m of members.data ?? []) {
    if (!activeUserIds.has(m.user_id)) continue;
    countBySector.set(m.sector_id, (countBySector.get(m.sector_id) ?? 0) + 1);
  }

  // Sem `member_user_ids`: quem lista as filas de uma PESSOA é
  // `/attendants/availability` (e é de lá que a tabela da Equipe lê). Devolver
  // aqui também seria o segundo leitor da mesma pergunta — e payload que
  // ninguém consome é o que o #3697 tirou da publicação em tempo real.
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
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "attendant_sectors",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "attendant_sectors", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const orgId = authz.organizationId;

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
    .insert({
      organization_id: orgId,
      name: input.name,
      description: input.description,
      // Omitir horário na criação = `{}` no banco = 24/7 (default da coluna).
      ...(input.schedule ? { schedule: input.schedule } : {}),
    })
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
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "attendant_sectors",
    resourceId: row.id,
    requestId,
    bypassedRls: true,
    metadata: { name: row.name },
  });

  return ok({ ...row, member_count: 0 }, { requestId, status: 201 });
}
