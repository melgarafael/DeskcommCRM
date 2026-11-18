import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/attendants/sector/[user_id] — define as FILAS do atendente.
 * Manager+.
 *
 * ─── O que mudou (migration 9062) ───────────────────────────────────────────
 *
 * Era "um setor por atendente" (`sector_id`, upsert da mesma linha), porque era
 * o que a PK de 0801 permitia. A operação pede o contrário: a recepção cobre
 * comercial e financeiro, o suporte cobre suporte e comercial de manhã. O corpo
 * agora é o CONJUNTO (`sector_ids`), e o vínculo passa a ter PK
 * `(organization_id, user_id, sector_id)`.
 *
 * A rota SUBSTITUI o conjunto da pessoa pelo recebido. Lista vazia é intenção
 * explícita ("não atende fila nenhuma"), não erro.
 *
 * ─── Por que inserir antes de apagar ────────────────────────────────────────
 *
 * Apagar tudo e reinserir deixaria uma janela em que a pessoa não está em fila
 * nenhuma — e o worker de roteamento, que lê essa tabela a cada conversa que
 * chega, poderia distribuir justamente nesse instante. Inserindo/atualizando o
 * conjunto novo primeiro e apagando só o que SOBROU, a pessoa nunca fica sem
 * fila no meio do caminho.
 *
 * O PRÓPRIO atendente não escolhe as filas — é decisão de quem gerencia a
 * equipe, e por isso a tabela não concede escrita a `authenticated`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { requireRole } from "@/lib/auth/require-role";
import { sectorAssignmentSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("manager", { requestId, resource: "attendant_sector_members" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { user_id: targetUserId } = await ctx.params;

  let input;
  try {
    input = await validateRequest(sectorAssignmentSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Lista sem repetição: o cliente pode mandar o mesmo id duas vezes ao marcar
  // e desmarcar; o conjunto é o que vale.
  const desejadas = [...new Set(input.sector_ids)];

  const admin = createAdminClient();

  const { data: member, error: memberErr } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", targetUserId)
    .is("revoked_at", null)
    .maybeSingle();
  if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
  if (!member) return fail("not_found", t("Atendente não encontrado na organização."), 404, { requestId });

  // Todas as filas pedidas têm de ser DESTA organização. Uma consulta só, e a
  // contagem fecha a checagem — a FK composta recusaria de qualquer forma, mas
  // aqui a resposta é 404 com frase em vez de 500 de constraint.
  if (desejadas.length > 0) {
    const { data: setores, error: setoresErr } = await admin
      .from("attendant_sectors")
      .select("id")
      .eq("organization_id", orgId)
      .in("id", desejadas);
    if (setoresErr) return fail("internal_error", setoresErr.message, 500, { requestId });
    if ((setores ?? []).length !== desejadas.length) {
      return fail("not_found", t("Setor não encontrado."), 404, { requestId });
    }
  }

  const { data: anteriores, error: anterioresErr } = await admin
    .from("attendant_sector_members")
    .select("sector_id")
    .eq("organization_id", orgId)
    .eq("user_id", targetUserId);
  if (anterioresErr) return fail("internal_error", anterioresErr.message, 500, { requestId });
  const antes = (anteriores ?? []).map((r) => r.sector_id).sort();

  const depois = [...desejadas].sort();

  // Nada mudou: não é mutação, não audita.
  if (antes.join(",") !== depois.join(",")) {
    if (desejadas.length > 0) {
      const agora = new Date().toISOString();
      const { error: upsertErr } = await admin
        .from("attendant_sector_members")
        .upsert(
          desejadas.map((sectorId) => ({
            organization_id: orgId,
            user_id: targetUserId,
            sector_id: sectorId,
            updated_at: agora,
          })),
          { onConflict: "organization_id,user_id,sector_id" },
        );
      if (upsertErr) return fail("internal_error", upsertErr.message, 500, { requestId });
    }

    // O que sobra sai: a lista recebida é a verdade. Lista vazia = apaga todos
    // os vínculos da pessoa.
    let remocao = admin
      .from("attendant_sector_members")
      .delete()
      .eq("organization_id", orgId)
      .eq("user_id", targetUserId);
    if (desejadas.length > 0) {
      remocao = remocao.not("sector_id", "in", `(${desejadas.join(",")})`);
    }
    const { error: deleteErr } = await remocao;
    if (deleteErr) return fail("internal_error", deleteErr.message, 500, { requestId });

    void audit({
      action: "attendant.sector_assigned",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "attendant_sector_members",
      resourceId: targetUserId,
      requestId,
      bypassedRls: true,
      metadata: {
        target_user_id: targetUserId,
        from_sector_ids: antes,
        to_sector_ids: depois,
      },
    });
  }

  return ok({ user_id: targetUserId, sector_ids: depois }, { requestId });
}
