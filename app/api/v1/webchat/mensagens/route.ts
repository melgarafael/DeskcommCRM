/**
 * POST /api/v1/webchat/mensagens — o visitante envia uma mensagem no chat no site (spec 36, F1).
 *
 * Pública, com o token de visitante no cabeçalho `Authorization: Bearer` (nunca na URL).
 * A conexão e a organização saem do TOKEN, assinado, e da linha da conexão no banco; o
 * corpo só traz o id da mensagem (idempotente) e o texto.
 *
 * Grava e enfileira, e responde 201 sem esperar a IA: a ingestão cuida do resto.
 */
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { conexaoPeloId, tokenDoBearer } from "@/lib/channels/webchat/conexao-pela-chave";
import { ingerirMensagemDoChat } from "@/lib/channels/webchat/ingest";
import { assinarTokenDeVisitante, lerTokenDeVisitante } from "@/lib/channels/webchat/token";
import { createAdminClient } from "@/lib/supabase/admin";

const TEXTO_MAXIMO = 2000;
/** Caracteres de controle proibidos. Tab e quebra de linha passam: são texto normal. */
const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const corpoSchema = z
  .object({
    mensagem_id: z.string().uuid(),
    texto: z
      .string()
      .transform((t) => t.trim())
      .pipe(z.string().min(1).max(TEXTO_MAXIMO).refine((t) => !CONTROLE.test(t))),
  })
  .strict();

/** Por visitante: 20 mensagens por minuto. Por conexão: 600 por minuto. */
const LIMITE_POR_VISITANTE = 20;
const LIMITE_POR_CONEXAO = 600;
const JANELA_SEGUNDOS = 60;

export async function POST(req: Request) {
  try {
    const token = tokenDoBearer(req.headers);
    if (!token) return fail("unauthenticated", "Missing token.", 401);

    const agora = new Date();
    const visitante = lerTokenDeVisitante(token, agora);
    if (!visitante.ok) return fail("unauthenticated", "Invalid token.", 401);

    const tetoVisitante = await checkRateLimit(
      `webchat:mensagens:visitante:${visitante.visitanteId}`,
      LIMITE_POR_VISITANTE,
      JANELA_SEGUNDOS,
    );
    if (!tetoVisitante.allowed) {
      return fail("rate_limited", "Too many requests.", 429, {
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }

    const lido = corpoSchema.safeParse(await req.json().catch(() => null));
    if (!lido.success) return fail("validation_failed", "Dados inválidos.", 422);
    const corpo = lido.data;

    const tetoConexao = await checkRateLimit(
      `webchat:mensagens:conexao:${visitante.channelSessionId}`,
      LIMITE_POR_CONEXAO,
      JANELA_SEGUNDOS,
    );
    if (!tetoConexao.allowed) {
      return fail("rate_limited", "Too many requests.", 429, {
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }

    const admin = createAdminClient();
    const conexao = await conexaoPeloId(admin, visitante.channelSessionId);
    // Conexão arquivada, organização suspensa ou módulo desligado: o mesmo 404 da chave.
    if (!conexao) return fail("not_found", "Not found.", 404);

    const resultado = await ingerirMensagemDoChat(admin, {
      organizationId: conexao.organizationId,
      channelSessionId: conexao.id,
      visitanteId: visitante.visitanteId,
      mensagemId: corpo.mensagem_id,
      texto: corpo.texto,
      agora,
    });

    return ok(
      {
        mensagem_id: corpo.mensagem_id,
        status: resultado.status,
        // Token perto do vencimento: o navegador troca pelo novo, com o mesmo visitante.
        ...(visitante.renovar
          ? {
              token_novo: assinarTokenDeVisitante({
                channelSessionId: visitante.channelSessionId,
                visitanteId: visitante.visitanteId,
                agora,
              }),
            }
          : {}),
      },
      { status: 201 },
    );
  } catch {
    return fail("internal_error", "Internal error.", 500);
  }
}
