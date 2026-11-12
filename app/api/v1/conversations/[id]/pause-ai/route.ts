import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/pause-ai — a pessoa assume o comando e o
 * atendimento automático para nesta conversa.
 *
 * ## Por que esta rota não existia
 *
 * Existia só a VOLTA (`reactivate-bot`). Não havia caminho nenhum, em rota ou em
 * tela, para desligar o automático numa conversa: ele calava por efeito colateral
 * — o agente escalando sozinho, ou a janela deslizante de 5 minutos que um envio
 * manual abre (`extendBotSilence`). Um par ligar/desligar com só um dos lados é
 * um interruptor que não desliga.
 *
 * ## O que ela grava, e por que não é `triggerHandoff`
 *
 * `triggerHandoff` (lib/ai/handoff/orchestrator.ts) faz quase isto e é o caminho
 * do AGENTE escalando: ele força `status='pending'`, que significa "na fila,
 * esperando um atendente". Aqui é o oposto — quem clicou está assumindo —, e
 * mandar a conversa para `pending` apagaria o dono da tela no exato gesto em que
 * a pessoa disse que ia cuidar.
 *
 * Então: silêncio durável (`bot_silenced_until='infinity'`) e, **se ninguém for
 * dono, um claim para quem clicou**. Pausar sem dono deixaria a conversa sem ator
 * nenhum — automático desligado e nenhuma pessoa responsável —, que é morte por
 * definição (invariante 4 do Sistema Vivo: nenhuma demanda sem próximo passo).
 *
 * **Não toca `contacts.force_human`.** Aquela trava é do CONTATO e vale para
 * todas as conversas dele; pausar UMA conversa não pode virar bloqueio geral do
 * cliente. Ela continua sendo escrita só por quem escala de verdade.
 *
 * ## A regra saiu daqui (#4517)
 *
 * Ela vive em `./_handler.ts` (`pausarIaHandler`), porque o mesmo gesto agora
 * acontece por TOKEN — e por ferramenta do agente. Esta rota resolve
 * autenticação (cookie OU Bearer `conversations:write`), tradução e HTTP; o
 * `claim`, o silêncio, o audit e a linha do tempo são os de sempre, num lugar só.
 *
 * A DIFERENÇA de comportamento entre os dois modos é a única que existe, e é
 * deliberada: o token NÃO assume a conversa sem dono (não tem carteira para
 * assumir). Está escrita e medida em `_handler.ts`.
 *
 * Auth: sessão de navegador, agent+ (spec 13 §4) — ou Bearer com
 * `conversations:write`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ESCOPO_CONVERSAS_ESCRITA } from "@/lib/api/escopos-do-token";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { pausarIaHandler } from "../_handler";

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
    const resultado = await pausarIaHandler(authz.supabase, {
      organization_id: authz.organizationId,
      actor: authz.actor,
      requestId,
      idioma: authz.idioma,
      ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
    }, id);

    return ok(
      {
        paused: true,
        assumiu_ao_pausar: resultado.assumiu_ao_pausar,
        conversation: resultado.conversation,
      },
      { requestId },
    );
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, t(err.message), err.status, { requestId });
    throw err;
  }
}
