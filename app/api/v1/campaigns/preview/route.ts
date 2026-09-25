/**
 * POST /api/v1/campaigns/preview — quantos, quem, e quem fica de fora.
 *
 * Não grava nada. Usa as MESMAS funções da preparação (`preverAudiencia` chama a
 * mesma consulta e a mesma classificação): prévia que mede por outro caminho é
 * prévia que mente, e a mentira só aparece depois do envio.
 *
 * É POST porque o filtro é um objeto — não porque muda alguma coisa.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { preverAudiencia } from "@/lib/campanhas/preparacao";
import { previaSchema } from "@/lib/campanhas/schemas";
import { TEXTO_DA_EXCLUSAO } from "@/lib/campanhas/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  // Guarda de suporte num handler que NÃO escreve: o gate
  // `tests/unit/suporte-cobertura-de-efeitos.test.ts` mede por MÉTODO, não por
  // efeito, e a exceção custaria mais que a restrição — uma sessão de suporte
  // não poder contar a prévia é um incômodo; um POST sem guarda por engano é
  // escrita em nome de outra pessoa.
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = previaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escolha pelo menos um critério de público."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  // Admin client com filtro explícito de organização (resolvida do papel, nunca
  // do corpo): a prévia varre contatos da organização inteira, inclusive os que
  // o usuário não veria por outro caminho — e é isso que ela precisa contar.
  const admin = createAdminClient();
  try {
    const resumo = await preverAudiencia(admin, {
      organizationId: authz.org.orgId,
      filtro: parsed.data.audience_filter,
      corpo: parsed.data.message_body,
      agora: new Date(),
      campanhaId: parsed.data.campaign_id,
    });
    return ok(
      {
        ...resumo,
        // O motivo vai junto com a frase: a tela mostra "12 pediram para não
        // receber", não "12 opt_out".
        legenda: TEXTO_DA_EXCLUSAO,
      },
      { requestId },
    );
  } catch (err) {
    // O texto real do erro sobe (Regra nº 1): "falha na operação" mandaria o
    // operador adivinhar qual filtro está errado.
    return fail("internal_error", err instanceof Error ? err.message : String(err), 500, {
      requestId,
    });
  }
}
