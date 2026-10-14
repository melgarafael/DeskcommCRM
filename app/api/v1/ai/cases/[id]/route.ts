import {lerComunicacaoDoCaso} from '@/lib/escalacao/comunicacao-do-caso';
import {getRequestPool} from '@/lib/agent-engine/db/request-pool';
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

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { conversasVisiveisDosCasos, lerChamado } from "@/lib/escalacao/chamados";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await params;

  let chamado;
  try {
    // O recorte é resolvido pelo cliente de SESSÃO e cobre só ESTE caso — não a
    // organização inteira. Quem devolve o 404 é `lerChamado`, com o conjunto
    // vazio: assim o gate tem um dono só, o mesmo `in (conversation_id)` que a
    // lista usa, em vez de uma segunda decisão escrita aqui.
    const visiveisPara = await conversasVisiveisDosCasos(await createClient(), org.orgId, {
      caseId: id,
    });
    chamado = await lerChamado(createAdminClient(), org.orgId, id, { visiveisPara });
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

  try { return ok({...chamado,communication:chamado.events.some(e=>e.kind==='human_replied')
    ?await lerComunicacaoDoCaso(getRequestPool(),org.orgId,id):[]}, {requestId}); }
  catch { return fail('unavailable','Não foi possível conferir a comunicação do Caso.',503,{requestId}); }
}
