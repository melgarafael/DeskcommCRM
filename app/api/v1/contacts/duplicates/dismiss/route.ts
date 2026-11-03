/**
 * POST /api/v1/contacts/duplicates/dismiss — "Não são a mesma empresa" (Spec 31, PR A).
 *
 * Tira da lista de Duplicados, para TODA a organização, um par de fichas que o
 * NOME sugeriu. A dispensa é a linha de `merge_queue` (`discarded`,
 * `nao_sao_a_mesma`) gravada por `dispensarParDeContatos`, sob trava: dispensar de
 * novo, ou com o par invertido, não grava segunda linha.
 *
 * Só par de nome se dispensa. Mesmo telefone ou mesmo e-mail é `par_forte` (422):
 * a sugestão forte não some por clique — junta-se as fichas.
 *
 * Esta rota é a porta: autoriza, valida, chama, audita. Mesmo papel da fusão
 * (`manager`), mesmo `requireSupportWrite` antes do efeito. A organização é a da
 * SESSÃO: um `organization_id` no corpo não tem campo no schema e é descartado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { dispensarParDeContatos } from "@/lib/contacts/dispensar-par";
import { contactsDismissDuplicateSchema, validateRequest } from "@/lib/schemas";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Sessão OU token de integração (Spec 33, R2): `mcp:write` e papel `manager`.
  // A organização sai da sessão ou da LINHA DO TOKEN.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contact",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;

  let input;
  try {
    input = await validateRequest(contactsDismissDuplicateSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Sem banco direto (`SUPABASE_DB_URL` ausente) ou com erro na transação, a
  // resposta segue o envelope `{error}` com `requestId` — nunca o 500 cru do Next.
  let resultado: Awaited<ReturnType<typeof dispensarParDeContatos>>;
  try {
    resultado = await dispensarParDeContatos(getRequestPool(), {
      organizationId: authz.organizationId,
      contactIds: input.contact_ids as [string, string],
      userId: authz.actor.type === "user" ? authz.actor.id : null,
    });
  } catch {
    return fail("internal_error", "Não foi possível dispensar a sugestão agora.", 500, { requestId });
  }

  if (!resultado.ok) {
    if (resultado.motivo === "nao_encontrado") {
      return fail(
        "not_found",
        "Um dos contatos não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.",
        404,
        { requestId },
      );
    }
    return fail(
      "not_dismissable",
      "Mesmo telefone ou mesmo e-mail não se dispensa: junte as fichas.",
      422,
      { requestId },
    );
  }

  // Audit SÓ quando houve efeito: repetir a dispensa de um par já dispensado não
  // mudou nada, e uma linha de trilha por clique repetido seria ruído. Metadado só
  // com os ids — nunca nome nem telefone.
  if (resultado.criada) {
    const [primeiroId] = resultado.candidatos;
    await audit({
      action: "contact.duplicate_dismissed",
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: authz.organizationId,
      resourceType: "contact",
      resourceId: primeiroId,
      requestId,
      metadata: { candidates: resultado.candidatos },
    });
  }

  return ok(
    { candidates: resultado.candidatos, criada: resultado.criada },
    { requestId, status: resultado.criada ? 201 : 200 },
  );
}
