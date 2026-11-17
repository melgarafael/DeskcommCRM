/**
 * POST /api/v1/contacts/duplicates/dismiss — "Não são a mesma empresa" (Spec 31, PR A).
 *
 * Tira da lista de Duplicados, para TODA a organização, um par de fichas que o
 * NOME sugeriu. A dispensa é a linha de `merge_queue` (`discarded`,
 * `nao_sao_a_mesma`) gravada por `dispensarParDeContatos`, sob trava: dispensar de
 * novo, ou com o par invertido, não grava segunda linha.
 *
 * Só par de nome se dispensa. Mesmo telefone, mesmo e-mail ou mesmo CPF é
 * `par_forte` (422): a sugestão forte não some por clique — junta-se as fichas.
 *
 * Esta rota é a porta: autoriza, valida, chama, audita. Mesmo papel da fusão
 * (`manager`), mesmo `requireSupportWrite` antes do efeito. A organização é a da
 * SESSÃO ou a da LINHA DO TOKEN (Spec 33, R2): um `organization_id` no corpo não
 * tem campo no schema e é descartado.
 *
 * Com token (`mcp:write`) a gravação segue pelo mesmo pool `pg`: o SQL de
 * `dispensarParDeContatos` filtra `organization_id` em toda leitura e na
 * escrita, e o par que não é da organização do token volta `nao_encontrado`.
 * Token não é pessoa: `resolved_by_user_id` fica nulo e o ator vai no audit.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ApiError } from "@/lib/api/types";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
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

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contact",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts_duplicates_dismiss", requestId); if (teto) return teto;
  const organizationId = authz.organizationId;
  const userId = authz.actor.type === "user" ? authz.actor.id : null;

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
      organizationId,
      contactIds: input.contact_ids as [string, string],
      userId,
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
      "Mesmo telefone, mesmo e-mail, mesmo CPF ou a mesma conta de WhatsApp não se dispensa: junte as fichas.",
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
      actorUserId: userId,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId,
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
