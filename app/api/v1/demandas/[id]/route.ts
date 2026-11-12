import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/demandas/[id] — marca o PRÓXIMO PASSO de uma demanda aberta.
 *
 * ## Por que esta rota existe
 *
 * O invariante 4 da doutrina ("nenhuma demanda sem próximo passo") já era
 * VISÍVEL em três lugares: contagem no painel de atrito, lista no Radar, e as
 * demandas do contato no painel do inbox. Em nenhum deles dava para RESOLVER —
 * o atendente enxergava o vazamento e tinha de sair da tela para agir.
 *
 * Isso foi denunciado pelo gate dos mapas de arquitetura
 * (`tests/unit/mapas-de-arquitetura.test.ts`): o node do inbox tinha UMA aresta,
 * só de entrada. Peça que só recebe é ilha pelo invariante 1, e o remédio certo
 * não era afrouxar o gate.
 *
 * ## As duas escritas, e por que a segunda existe
 *
 * `proximo_passo` sozinho seria uma anotação. Com `proximo_passo_em` ele vira
 * compromisso datado, que é o que o Radar e o índice sabem cobrar. O texto é
 * obrigatório; a data é opcional — obrigá-la faria o atendente inventar uma
 * para se livrar do campo, e data inventada é pior que data ausente.
 *
 * ## Sessão OU token (Spec 33, R2)
 *
 * Entra por `resolveAuthDual`. As duas escritas já usavam o cliente de serviço
 * com `organization_id` à mão (a RPC recebe `p_org`, o `update` filtra a
 * organização); no ramo do token a organização é a da LINHA DO TOKEN. Quem
 * encerra grava `encerrada_por` e a atividade do negócio com o id da PESSOA da
 * sessão, ou `null` quando é um token — nunca o id do token.
 *
 * ## Piso `agent`, e não `manager`
 *
 * Quem atende é quem sabe o que vem a seguir. Exigir gerente aqui empurraria o
 * registro para depois — e "depois" é exatamente o estado que esta rota existe
 * para eliminar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

const passoSchema = z.object({
  proximo_passo: z.string().trim().min(3).max(500),
  /** ISO 8601 absoluto. Ausente é legítimo: nem todo passo tem hora marcada. */
  proximo_passo_em: z.string().datetime({ offset: true }).nullish(),
});

const encerrarSchema = z.object({
  action: z.literal("encerrar"),
  expected_revision: z.number().int().positive(),
  desfecho: z.enum(["resolvida", "convertida", "nao_procede", "encerrada_pelo_cliente", "perdida", "expirada_sem_resposta"]),
});
const patchSchema = z.union([encerrarSchema, passoSchema]);

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Sessão OU token (Spec 33, R2): `agent` na sessão, `mcp:write` no token. A
  // organização sai da sessão ou da LINHA DO TOKEN, nunca do corpo nem do path.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "demandas",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "demandas", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const organizationId = authz.organizationId;
  // `encerrada_por` e `performed_by_user_id` têm FK para `auth.users`: o id de um
  // token não é pessoa. Só a sessão assina; o token grava `null` (as duas colunas
  // aceitam, e a função não cobra auth.uid()).
  const autorId = authz.actor.type === "user" ? authz.actor.id : null;
  const apiTokenId = authz.apiTokenId ?? null;

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("validation_failed", t("Corpo inválido."), 422, { requestId });
  }
  const parsed = patchSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail(
      "validation_failed",
      t("O próximo passo precisa ter de 3 a 500 caracteres."),
      422,
      { details: parsed.error.flatten().fieldErrors as Record<string, unknown>, requestId },
    );
  }

  const admin = createAdminClient();

  if ("action" in parsed.data) {
    const { data, error } = await admin.rpc("fn_demanda_encerrar", {
      p_org: organizationId, p_demanda: id, p_expected: parsed.data.expected_revision,
      p_desfecho: parsed.data.desfecho, p_actor: autorId,
    });
    // PT409: revisão obsoleta (migration 0654). 40001: banco anterior à 0654.
    const conflito = error?.code === "PT409" || error?.code === "40001";
    if (error) return fail(conflito ? "conflict" : error.code === "P0002" ? "not_found" : "internal_error",
      conflito ? "Esta demanda mudou. Atualize antes de encerrar." : error.message,
      conflito ? 409 : error.code === "P0002" ? 404 : 500, { requestId });
    void audit({ action: "demanda.encerrada", actorUserId: autorId, actorApiTokenId: apiTokenId,
      organizationId, resourceType: "demanda", resourceId: id, requestId,
      metadata: { desfecho: parsed.data.desfecho } });
    return ok(data, { requestId });
  }

  // Service role bypassa RLS: o `organization_id` vem do CONTEXTO autenticado e
  // é filtro explícito no update, nunca do corpo. E `fechada_em is null` porque
  // marcar o próximo passo de uma demanda encerrada é reabrir pela porta dos
  // fundos — sem desfecho, sem registro, sem ninguém saber.
  const { data, error } = await admin
    .from("demandas")
    .update({
      proximo_passo: parsed.data.proximo_passo,
      proximo_passo_em: parsed.data.proximo_passo_em ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .is("fechada_em", null)
    .select("id, proximo_passo, proximo_passo_em")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  // Zero linhas é indistinguível de sucesso no PostgREST — o bug conhecido de
  // `organizations` engana exatamente assim. Aqui o `select` de volta é o que
  // separa "gravou" de "não achou/já fechada".
  if (!data) {
    return fail("not_found", t("Demanda não encontrada, ou já encerrada."), 404, { requestId });
  }

  void audit({
    action: "demanda.proximo_passo_definido",
    actorUserId: autorId,
    actorApiTokenId: apiTokenId,
    organizationId,
    resourceType: "demanda",
    resourceId: id,
    requestId,
    metadata: {
      proximo_passo: parsed.data.proximo_passo,
      proximo_passo_em: parsed.data.proximo_passo_em ?? null,
    },
  });

  return ok(data, { requestId });
}
