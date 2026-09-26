import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { validateRequest } from "@/lib/schemas";
import {
  criarRascunho,
  JANELA_MAXIMA_HORAS,
  JANELA_PADRAO_HORAS,
  TEXTO_MAXIMO,
} from "@/lib/inbox/rascunho-sugerido";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O que a rota devolve — é também o que o recibo de idempotência guarda. */
type Resposta = { draft_id: string; url: string };

/** Tag do endpoint no recibo de idempotência. Muda de rota muda de recibo. */
const ENDPOINT = "/api/v1/conversations/[id]/drafts";

/**
 * POST /api/v1/conversations/[id]/drafts — a porta de criação do rascunho
 * sugerido por integração (issue #1611).
 *
 * Devolve a URL; NUNCA envia mensagem. Quem recebe o link abre a conversa com o
 * texto no `Composer` e o aviso de origem, e só um clique de gente manda.
 *
 * Auth-dual (sessão OU Bearer `dsk_...` com escopo `mcp:write`) — a mesma
 * metade que `POST /api/v1/conversations/open-with-contact` já aceita, porque a
 * conversa pode nascer ali. O rate limit por token é o mesmo das outras portas
 * que aceitam Bearer (`tetoDeEscritaDoToken`): o que não é contado na rota não
 * é contado em lugar nenhum.
 *
 * Com `Idempotency-Key`, `comIdempotencia` reserva a chave ANTES do efeito: a
 * retentativa da integração recebe o recibo em vez de criar o segundo rascunho.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // O ramo do token não traz idioma: cai no padrão do produto.
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const teto = await tetoDeEscritaDoToken(authz, "drafts", requestId);
  if (teto) return teto;

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_error", t("Conversa inválida."), 422, { requestId });
  }

  let input;
  try {
    input = await validateRequest(
      z.object({
        texto: z.string().min(1).max(TEXTO_MAXIMO),
        origem: z.string().trim().min(1).max(64).default("integracao"),
        expira_em_horas: z
          .number()
          .int()
          .min(1)
          .max(JANELA_MAXIMA_HORAS)
          .default(JANELA_PADRAO_HORAS),
      }),
      req,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Idempotency-Key, quando vem, tem de ser UUID — mesma régua de
  // `message-templates` e do contrato (spec 01 §7.3).
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  // Em constantes antes do fechamento: `criar()` é declaração (hoisted), e o TS
  // não leva para dentro dela o estreitamento de `authz.ok` nem o tipo do `let`.
  const { supabase, organizationId, actor, apiTokenId } = authz;
  const dados = input;

  /**
   * O efeito. Lança em falha de propósito: recibo de operação que falhou seria
   * pior que não ter idempotência — o cliente retentaria e receberia o replay
   * de uma criação que nunca existiu.
   */
  async function criar(): Promise<Resposta> {
    const resultado = await criarRascunho(supabase, {
      organizationId,
      conversationId: id,
      texto: dados.texto,
      origem: dados.origem,
      expiraEmHoras: dados.expira_em_horas,
      apiTokenId: apiTokenId ?? null,
    });

    if (!resultado.ok) {
      if (resultado.motivo === "conversa_nao_encontrada") {
        throw new ApiError(404, "not_found", undefined, requestId, t("Conversa não encontrada."));
      }
      const mensagem =
        resultado.motivo === "origem_invalida"
          ? "Origem do rascunho inválida."
          : "Texto do rascunho inválido.";
      throw new ApiError(422, "validation_error", undefined, requestId, t(mensagem));
    }

    await audit({
      action: "conversation.draft_created",
      actorUserId: actor.type === "user" ? actor.id : null,
      actorApiTokenId: apiTokenId ?? null,
      organizationId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: { draft_id: resultado.draftId, origem: dados.origem },
    });

    return { draft_id: resultado.draftId, url: resultado.url };
  }

  try {
    // Sem a chave, o caminho é o de sempre: ela só existe quando quem chama
    // quer retentativa segura.
    const desfecho =
      chave === null
        ? ({ tipo: "executou", resposta: await criar(), status: 201 } as const)
        : await comIdempotencia({
            db: supabase,
            organizationId,
            endpoint: ENDPOINT,
            chave,
            // O caminho entra no corpo: a MESMA chave em OUTRA conversa é
            // conflito, e não replay do rascunho da primeira.
            corpo: { conversation_id: id, ...dados },
            executar: async () => ({ resposta: await criar(), status: 201 }),
          });

    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    // `em_curso` não é conflito: aqui a chave está CERTA e retentar resolve.
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }

    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
