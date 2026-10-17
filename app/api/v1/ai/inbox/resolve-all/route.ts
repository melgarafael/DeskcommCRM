import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — resolve de uma vez TODOS os avisos abertos da org.
 *
 * POST sem corpo. A Central só resolvia item a item (`[id]/route.ts`), e uma
 * instalação real chegou a 144 abertos: a única saída era clicar 144 vezes.
 *
 * ─── Por que não há Zod aqui, se a doutrina manda validar todo input ───────
 *
 * Porque NÃO HÁ input externo. Não há corpo lido, não há query, não há
 * parâmetro de rota: a organização vem do cookie validado contra as
 * memberships (`requireRole` → `resolveActiveOrg`) e o ator vem do JWT
 * (`getUser`). O único predicado do `update` — a própria org e `status='open'`
 * — é resolvido no servidor. Um `z.object({}).strict()` sobre um corpo que
 * ninguém lê validaria nada e criaria um modo de falha novo. Se um dia esta
 * rota aceitar um recorte (um `kind`, uma faixa de data), ele nasce com Zod.
 *
 * ─── O audit não leva resource_id, e isso é o conserto de um bug ──────────
 *
 * `api_audit_log.resource_id` é `uuid`. Um rótulo como `"bulk"` ali devolve
 * `invalid input syntax for type uuid`, e como o audit é fire-and-forget a
 * mutação segue verde enquanto a trilha some — exatamente o modo de falha que
 * o cabeçalho de `lib/audit/index.ts` documenta, e que
 * `tests/unit/audit-resource-id-e-uuid` reprova. O lote não tem UM recurso: o
 * campo vai nulo e a contagem vai no metadata, o mesmo desenho de
 * `app/api/v1/leads/bulk/route.ts`.
 *
 * Rodada sem efeito (nenhum aviso aberto) não audita: não houve mutação, e
 * auditar o vazio é a mesma poluição que a doutrina já barrou nos crons.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { avisoVisivelPara } from "@/lib/ai/inbox-destino";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Mesmo piso do aviso avulso (`agent` — spec 13 §4, viewer é read-only). O
  // lote é mais largo, mas não é mais destrutivo: resolver não apaga nada,
  // reabrir continua permitido, e a linha resolvida segue visível na aba
  // "Resolvidos". Subir para `manager` exigiria gatear o botão em `manager`
  // também — senão a tela oferece ao atendente o que a rota recusa.
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org } = authz;

  // Service role bypassa RLS: o filtro por organização é EXPLÍCITO e vem da org
  // ativa resolvida do cookie, nunca do corpo. Sem ele o update alcançaria os
  // avisos de todos os tenants da instalação.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", org.orgId)
    // Só o que ESTA pessoa vê: o aviso pessoal do colega (0689) não é dela para resolver.
    .or(avisoVisivelPara(authUser.id))
    .eq("status", "open")
    .select("id");
  if (error) {
    return fail("internal_error", t("Falha ao resolver os avisos."), 500, { requestId });
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    await audit({
      action: "ai.inbox_item_status_changed",
      actorUserId: authUser.id,
      organizationId: org.orgId,
      resourceType: "agent_inbox_items",
      resourceId: null,
      requestId,
      metadata: { status: "resolved", bulk: true, count },
    });
  }

  return ok({ resolved_count: count }, { requestId });
}
