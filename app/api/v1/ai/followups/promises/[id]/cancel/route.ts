/**
 * POST /api/v1/ai/followups/promises/:id/cancel (manager+) — a pessoa desmarca
 * um RETORNO agendado (a promessa avulsa, `cron_jobs`), não um enrollment do
 * motor de fluxos.
 *
 * ⚠️ ESTA ROTA FECHA UM BURACO DE CONTINUIDADE. A fila já mostrava as promessas
 * lado a lado com os enrollments, mas o botão de cancelar só existia para os
 * segundos — o cabeçalho de `enrollments/[id]/cancel` dizia, com todas as
 * letras, que promessa "não é cancelável por aqui". Na prática: o agente
 * prometia voltar, a pessoa via na tela que o retorno estava marcado, discordava,
 * e não tinha o que fazer. Sem esta porta, o invariante 2 da doutrina
 * (continuidade nas duas direções) valia só no sentido IA→humano.
 *
 * A regra é a MESMA que a capacidade da IA usa (`lib/followup/retorno.ts`), e o
 * cancelamento emite atividade na timeline — é por ela que o agente descobre, ao
 * retomar, que uma pessoa desmarcou e não deve reagendar o mesmo retorno.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import type { Actor } from "@/lib/api/handlers/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { cancelaRetornoNoCrm } from "@/lib/followup/retorno-crm";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_promises",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_promises", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { organizationId } = authz;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  // Admin client porque a operação compartilhada escreve atividade e lê o
  // negócio dono do contato; a organização vem do token/sessão, nunca do
  // caminho nem do body, e toda query da operação filtra por ela.
  const actor: Actor =
    authz.actor.type === "user"
      ? { type: "user", id: authz.actor.id }
      : { type: "api_token", id: authz.apiTokenId ?? "desconhecido" };
  const resultado = await cancelaRetornoNoCrm(
    {
      admin: createAdminClient(),
      orgId: organizationId,
      actor,
      requestId,
    },
    id,
    // Motivo fixo e legível: quem cancela pela fila não escreve texto, e o que
    // importa para o agente é QUEM desmarcou, não uma justificativa inventada.
    { motivo: "desmarcado por uma pessoa da equipe" },
  );

  if (!resultado.ok) {
    if (resultado.codigo === "nao_encontrado") {
      return fail("not_found", t("Retorno não encontrado."), 404, { requestId });
    }
    return fail("already_terminal", t("Este retorno já aconteceu ou já foi cancelado."), 409, {
      requestId,
    });
  }

  void audit({
    action: "followup.cancelled",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "cron_job",
    resourceId: id,
    requestId,
    metadata: {
      actor_type: actorUserId ? "user" : "api_token",
      via: "fila",
      contact_id: resultado.retorno.contactId,
      lead_id: resultado.alvo?.leadId ?? null,
    },
  });

  return ok(
    {
      id: resultado.retorno.id,
      status: "cancelado",
      cancelled_at: resultado.retorno.canceladoEm,
    },
    { requestId },
  );
}
