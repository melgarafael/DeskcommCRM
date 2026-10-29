/**
 * As vozes que a resposta em áudio aceita — só pt-BR Standard
 * (`lib/agent-engine/edge/voz/vozes.ts`) —, consultadas no Google PELO SERVIDOR
 * com a chave da organização (ou, sem ela, a da instalação).
 *
 * Cada voz sai só com nome e gênero. Sem chave
 * nenhuma: 409 `voz_nao_configurada`. Erro do Google: 502 com código e status.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerChaveDaVoz } from "@/lib/ai/voz/credencial";
import { FalhaDaVoz, listarVozesPtBr } from "@/lib/agent-engine/edge/voz/sintese";
import { VOZ_PADRAO } from "@/lib/agent-engine/edge/voz/vozes";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const chave = await lerChaveDaVoz(createAdminClient(), authz.org.orgId);
  if (!chave) {
    return fail("voz_nao_configurada", t("Cadastre a chave do Google Cloud Text-to-Speech em IA › Provedores."), 409, {
      requestId,
    });
  }
  try {
    const vozes = await listarVozesPtBr(chave.chave);
    return ok({ vozes, padrao: VOZ_PADRAO, origem: chave.origem }, { requestId });
  } catch (err) {
    const codigo = err instanceof FalhaDaVoz ? err.code : "rede";
    const status = err instanceof FalhaDaVoz ? err.status : null;
    return fail("voz_indisponivel", t("O Google não devolveu a lista de vozes. Teste a chave."), 502, {
      requestId,
      details: { codigo, status },
    });
  }
}
