/**
 * GET /api/v1/ai/cases/:id — detalhe do caso + timeline (spec 15 §7, Wave 5).
 * Read-only via PostgREST, org-scoped, 404 honesto.
 *
 * A consulta vive em `lib/escalacao/chamados.ts` — a capacidade "ler um chamado e
 * o que a pessoa decidiu" do agente lê o mesmo detalhe e a mesma linha do tempo.
 *
 * O 404 aqui cobre TRÊS coisas com a mesma resposta: o caso não existe, é de
 * outra organização, ou a conversa dele está fora do que a RLS mostra a quem
 * pediu. É de propósito — um 403 no terceiro confirmaria a existência do caso
 * para quem não pode vê-lo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { conversasVisiveisDosCasos, lerChamado, type ConversasVisiveis } from "@/lib/escalacao/chamados";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  // Sessão OU token (Spec 33, R1): o token precisa de config:read e papel admin.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "agent_cases",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "agent_cases", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };
  const { id } = await params;

  let chamado;
  try {
    // O recorte é resolvido pelo cliente de SESSÃO e cobre só ESTE caso — não a
    // organização inteira. Quem devolve o 404 é `lerChamado`, com o conjunto
    // vazio: assim o gate tem um dono só, o mesmo `in (conversation_id)` que a
    // lista usa, em vez de uma segunda decisão escrita aqui.
    // Token: admin é org-wide por desenho; a existência do caso na organização
    // continua sendo conferida por `lerChamado` (filtra organization_id e id).
    const visiveisPara: ConversasVisiveis =
      authz.via === "token"
        ? "todas"
        : await conversasVisiveisDosCasos(authz.supabase, org.orgId, { caseId: id });
    chamado = await lerChamado(createAdminClient(), org.orgId, id, {
      visiveisPara,
      contatoSeparado: authz.via === "token",
    });
  } catch (erro) {
    // Mesma correção da lista (ver o `catch` de `app/api/v1/ai/cases/route.ts`):
    // um 500 sem causa registrada deixa a tela vazia e o log mudo, e quem
    // diagnostica fica entre um banco correto e uma tela errada sem nada no meio.
    logger.error("[ai/cases] falha ao carregar o caso", {
      requestId,
      organizationId: org.orgId,
      caseId: id,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail("internal_error", t("Falha ao carregar o caso."), 500, { requestId });
  }
  if (!chamado) return fail("not_found", t("Caso não encontrado."), 404, { requestId });

  return ok(chamado, { requestId });
}
