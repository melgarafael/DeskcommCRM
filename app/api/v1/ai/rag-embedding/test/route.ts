/**
 * POST /api/v1/ai/rag-embedding/test — testa a chave de embedding de verdade.
 *
 * Não é o "revalidar credencial" (que só pergunta ao provedor se a chave
 * existe): aqui roda um **embedding real** pelo MESMO caminho da indexação e da
 * busca. É o que prova que a base vai funcionar — chave válida, provedor certo,
 * modelo certo e dimensão certa (a asserção de 1536 do `embedText`).
 *
 * Auth: cookie session, role >= manager. `organization_id` vem do JWT.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { embedText } from "@/lib/ai/embed";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_embeddings" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  try {
    const r = await embedText("teste de conexão da base de conhecimento", {
      organizationId: org.orgId,
      ponto: "embedding_indexar",
    });
    return ok(
      {
        ok: true,
        model: r.model,
        dims: r.embedding.length,
        prompt_tokens: r.promptTokens,
      },
      { requestId },
    );
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    // A mensagem do provedor é útil para o dono (chave inválida, cota, rede) —
    // truncada e sem ecoar a chave (o SDK não a inclui no erro).
    return ok({ ok: false, erro: mensagem.slice(0, 400) }, { requestId });
  }
}
