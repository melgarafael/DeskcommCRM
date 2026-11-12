import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/reactivate-bot
 *
 * Devolve o atendimento ao agente. A REGRA vive em
 * `lib/escalacao/retomada.ts` (+ a casca em `./_handler.ts`) — esta rota só
 * resolve autenticação, org e a tradução do resultado para HTTP.
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
 * ## #4517 — a terceira porta, e a diferença que ela exige
 *
 * A integração com `conversations:write` também retoma por aqui. Só que ela NÃO
 * pode soltar o dono (`release`), porque a issue é explícita: pausar e retomar
 * não trocam o responsável da conversa nem o do negócio. Então o modo token
 * limpa SÓ o silêncio, e a resposta diz se o automático realmente voltou
 * (`automacao_liberada`) — com dono humano, ele continua vetado, e fingir
 * `reactivated: true` seria mentira. Detalhe e teste em `./_handler.ts`.
 *
 * Auth: cookie session, role >= agent — ou Bearer com `conversations:write`.
 * Audit: `ai.reactivated_by_agent` (pessoa) / `conversation.ai_resumed_by_token`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ESCOPO_CONVERSAS_ESCRITA } from "@/lib/api/escopos-do-token";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { retomarIaHandler } from "../_handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: ESCOPO_CONVERSAS_ESCRITA,
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  try {
    const resultado = await retomarIaHandler(authz.supabase, {
      organization_id: authz.organizationId,
      actor: authz.actor,
      requestId,
      idioma: authz.idioma,
      ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
    }, id);

    if (!resultado.automacao_liberada) {
      // 200, e não erro: o gesto foi feito (o silêncio saiu) e o que impede o
      // automático é um estado que a integração precisa VER — o dono humano ou a
      // marca do contato. Erro faria a integração repetir um gesto já aplicado.
      const motivo =
        resultado.motivo_bloqueio === "contato_sempre_humano"
          ? "Este contato está marcado como sempre atendimento humano. Para a IA voltar a atendê-lo, remova a marca na ficha do contato."
          : "A conversa está com um atendente humano. O automático volta quando o atendimento for devolvido pela tela.";
      return ok(
        {
          reactivated: false,
          automacao_liberada: false,
          motivo_bloqueio: resultado.motivo_bloqueio,
          mensagem: t(motivo),
        },
        { requestId },
      );
    }

    return ok(
      {
        reactivated: true,
        automacao_liberada: true,
        // O que a pessoa fez vai junto: quem chamou consegue mostrar na tela que
        // o agente não voltou cego. O token não tem continuidade (não havia
        // atendimento humano dele para resumir).
        ...(resultado.continuidade !== undefined ? { continuidade: resultado.continuidade } : {}),
      },
      { requestId },
    );
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, t(err.message), err.status, { requestId });
    throw err;
  }
}
