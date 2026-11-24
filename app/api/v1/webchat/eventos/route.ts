/**
 * GET /api/v1/webchat/eventos — o visitante recebe as respostas da conversa por stream
 * (spec 36, F1, Task 9).
 *
 * Pública, com o token de visitante no cabeçalho `Authorization: Bearer` (nunca na URL). A
 * conexão, a organização e a conversa saem do TOKEN e da linha da conexão no banco. O pedido
 * não traz parâmetro nenhum que escolha dado: a entrega é pelo estado da mensagem.
 *
 * O stream lê o banco a cada 2 s e fecha em 60 s: a janela reabre e recebe o que ainda está
 * `sent`.
 */
import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { conexaoPeloId, tokenDoBearer } from "@/lib/channels/webchat/conexao-pela-chave";
import { descreverErro } from "@/lib/channels/webchat/entrada-publica";
import { abrirFluxoDeEventos } from "@/lib/channels/webchat/eventos";
import { lerTokenDeVisitante } from "@/lib/channels/webchat/token";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** Por visitante: 6 aberturas por minuto. */
const LIMITE_DE_ABERTURAS = 6;
const JANELA_SEGUNDOS = 60;

function recusaPorLimite() {
  return fail("rate_limited", "Too many requests.", 429, {
    headers: { "Retry-After": String(JANELA_SEGUNDOS) },
  });
}

export async function GET(req: Request) {
  try {
    const token = tokenDoBearer(req.headers);
    if (!token) return fail("unauthenticated", "Missing token.", 401);

    const visitante = lerTokenDeVisitante(token, new Date());
    if (!visitante.ok) {
      // Sem segredo no servidor nenhum token pode ser conferido: defeito de configuração, e não
      // credencial errada. Por isso 500 e registro, e não 401.
      if (visitante.motivo === "segredo_ausente") {
        logger.error("webchat: INTERNAL_SECRET ausente; token de visitante não pode ser conferido", {
          rota: "eventos",
          motivo: visitante.motivo,
        });
        return fail("internal_error", "Internal error.", 500);
      }
      return fail("unauthenticated", "Invalid token.", 401);
    }

    const teto = await checkRateLimit(
      `webchat:eventos:visitante:${visitante.visitanteId}`,
      LIMITE_DE_ABERTURAS,
      JANELA_SEGUNDOS,
    );
    if (!teto.allowed) return recusaPorLimite();

    const admin = createAdminClient();
    const conexao = await conexaoPeloId(admin, visitante.channelSessionId);
    // Conexão arquivada, organização suspensa ou módulo desligado: o mesmo 404 da chave.
    if (!conexao) return fail("not_found", "Not found.", 404);

    const corpo = abrirFluxoDeEventos({
      admin,
      organizationId: conexao.organizationId,
      channelSessionId: conexao.id,
      visitanteId: visitante.visitanteId,
      sinal: req.signal,
    });

    return comIdDaRequisicao(
      new Response(corpo, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          // Proxy reverso (nginx e afins) não pode segurar o stream em buffer.
          "X-Accel-Buffering": "no",
        },
      }),
      req,
    );
  } catch (erro) {
    logger.error("webchat: erro na rota pública de eventos", {
      rota: "eventos",
      ...descreverErro(erro),
    });
    return fail("internal_error", "Internal error.", 500);
  }
}
