import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/reactivate-bot
 *
 * Devolve o atendimento ao agente. A REGRA vive em
 * `lib/escalacao/retomada.ts` — esta rota só resolve autenticação, org e a
 * tradução do resultado para HTTP.
 *
 * Ela foi extraída (Decisão 4 do briefing IA 360: a tool é fachada fina sobre a
 * regra que já existe) porque a mesma devolução precisa acontecer por dois
 * caminhos — a pessoa clicando aqui e a capacidade exposta ao agente. Regra
 * duplicada nos dois lados faria o sistema mentir para um deles.
 *
 * Ao extrair, apareceu o defeito: esta rota limpava só `bot_silenced_until` e
 * respondia `{ reactivated: true }` com o agente ainda travado por
 * `contacts.force_human` e por `assignee_kind='user'`. O conserto está na função;
 * o histórico do defeito, no cabeçalho dela.
 *
 * Auth: cookie session, role >= agent. Audit: `ai.reactivated_by_agent`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const supabase = await createClient();

  const resultado = await devolverAtendimentoAoAgente(
    {
      supabase,
      organizationId: activeOrg.orgId,
      actor: { type: "user", id: authUser.id, role: activeOrg.role },
      requestId,
    },
    { conversationId: id },
  );

  if (!resultado.ok) {
    if (resultado.erro === "conversation_not_found") {
      return fail("not_found", "Conversa não encontrada.", 404, { requestId });
    }
    if (resultado.erro === "assignment_conflict") {
      return fail(
        "state_conflict",
        "Alguém assumiu esta conversa agora — recarregue e tente de novo.",
        409,
        { requestId },
      );
    }
    // A devolução em si já aconteceu; o que falhou foi o sinal que retoma um
    // acompanhamento pausado. Repetir a chamada é seguro (tudo é idempotente).
    return fail(
      "internal_error",
      "Atendimento devolvido, mas o sinal de retomada do acompanhamento falhou — tente de novo.",
      500,
      { requestId },
    );
  }

  return ok(
    {
      reactivated: true,
      // O que a pessoa fez vai junto: quem chamou consegue mostrar na tela que o
      // agente não voltou cego.
      continuidade: {
        houve_atendimento_humano: resultado.continuidade.houveAtendimentoHumano,
        resumo: resultado.continuidade.resumo,
        decisoes: resultado.continuidade.decisoes.length,
        notas: resultado.continuidade.notas.length,
      },
    },
    { requestId },
  );
}
