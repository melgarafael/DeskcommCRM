/**
 * O que as DUAS entradas de canal fazem depois de saber de quem é o evento:
 * a por sessão (`channel/[token]`, que resolve a sessão pelo token do caminho)
 * e a da instalação (`canal-da-instalacao`, que resolve pela conta do evento).
 *
 * Um caminho só, de propósito: arquivo do corpo cru, assinatura, conta, ingestão
 * e as respostas que o provedor lê. Duas cópias divergiriam na primeira mudança
 * — e a divergência apareceria como mensagem que entra por um caminho e some
 * pelo outro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { abrirArquivoDoWebhook, fecharArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import {
  handleInboundWebhook,
  inboundPayloadBelongsToSession,
  verifyInboundWebhookSignature,
  type InboundWebhookInput,
} from "@/lib/channels/inbound";
import { logger } from "@/lib/logger";

export async function processarEntradaDoCanal(
  admin: SupabaseClient,
  entrada: {
    sessao: InboundWebhookInput["session"];
    rawBody: string;
    headers: Headers;
    secret: string | null;
    requestId: string;
  },
): Promise<Response> {
  const { sessao, rawBody, secret, requestId } = entrada;
  const req = { headers: entrada.headers };
  // ─── O corpo cru vai para o arquivo ANTES de qualquer processamento ────────
  //
  // Se o processo morrer no meio — exceção, OOM, deploy no instante errado — o
  // payload continua gravado, que é justamente quando alguém vai querer lê-lo.
  // Este caminho não gravava NADA, enquanto a rota do outro canal grava desde
  // sempre: era o único canal sem instrumento para investigar o que chegou.
  //
  // ⚠️ ANTES DA CONFERÊNCIA DE ASSINATURA, e isso é o conserto: a recusa por
  // assinatura saía com `return` LOGO ACIMA desta linha. Consequência dupla —
  // o payload recusado não era arquivado em lugar nenhum, e o ramo que grava
  // `valid_signature: false` (mais abaixo) ficava INALCANÇÁVEL, porque a única
  // recusa por assinatura já tinha saído antes. Uma recusa de segurança que não
  // deixa rastro de si mesma é pior que não ter a recusa: ninguém descobre que
  // está sendo tentada.
  //
  // Pela rota por sessão, quem chega aqui já apresentou o TOKEN certo (a sessão
  // foi resolvida por ele) e errou o SEGREDO de assinatura. Isso não é ruído de
  // internet: é alguém com metade das credenciais. Arquivar é o que permite
  // descobrir isso. (A entrada da instalação confere a assinatura antes de
  // achar a sessão, então aqui ela sempre passa.)
  const arquivo = await abrirArquivoDoWebhook(admin, {
    organizationId: sessao.organization_id,
    channelSessionId: sessao.id,
    provider: sessao.provider,
    rawBody,
    headers: req.headers,
  });

  if (!verifyInboundWebhookSignature(sessao.provider, rawBody, req.headers, secret)) {
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: false,
      erro: "bad_signature",
    });
    // E DEIXA RASTRO NO LOG, que é onde quem opera olha primeiro. `warn` e não
    // `error`: uma tentativa isolada não é incidente, mas uma sequência delas é
    // — e sem esta linha nem a sequência aparecia.
    logger.warn("[webhook-canal] assinatura recusada", {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      provider: sessao.provider,
      request_id: requestId,
    });
    return fail("unauthorized", "bad_signature", 401, { requestId });
  }

  if (
    !(await inboundPayloadBelongsToSession(admin, {
      session: sessao,
      rawBody,
      headers: req.headers,
      secret,
    }))
  ) {
    // Assinatura BOA, conta errada: `validSignature: true` de propósito. Marcar
    // `false` aqui mandaria quem investiga procurar um problema de segredo que
    // não existe — o segredo está certo, o evento é que é de outra conta.
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: true,
      erro: "evento_de_outra_conta",
    });
    return ok({ status: "ignored", reason: "evento_de_outra_conta" }, { requestId });
  }

  try {
    const r = await handleInboundWebhook(admin, {
      session: sessao,
      rawBody,
      headers: req.headers,
      secret,
    });

    if (r.ok) {
      await fecharArquivoDoWebhook(admin, arquivo, {
        status: "processed",
        validSignature: true,
        // O desfecho do seam vai junto: é ele que distingue "ingerido" de
        // "ignorado por falta de identidade" quando alguém for contar depois.
        erro: typeof r.body.reason === "string" ? r.body.reason : null,
      });
      return ok(r.body, { requestId });
    }

    const status = r.code === "unauthorized" ? 401 : 400;
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      // `false` SÓ quando a recusa foi por assinatura. Um payload bem assinado
      // que o parser recusou não é problema de segredo, e marcá-lo como se
      // fosse mandaria quem investiga procurar no lugar errado.
      validSignature: r.code === "unauthorized" ? false : null,
      erro: r.message,
    });
    return fail(r.code === "unauthorized" ? "unauthorized" : "invalid_request", r.message, status, {
      requestId,
    });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "ingest_failed";
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: null,
      erro: detalhe,
    });
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
