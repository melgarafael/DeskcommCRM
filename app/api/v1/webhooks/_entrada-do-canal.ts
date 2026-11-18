/**
 * O que as DUAS entradas de canal fazem depois de saber de quem é o evento:
 * a por sessão (`channel/[token]`, que resolve a sessão pelo token do caminho)
 * e a da instalação (`canal-da-instalacao`, que resolve pela conta do evento).
 *
 * Um caminho só, de propósito: arquivo do corpo cru, assinatura, conta, ingestão
 * e as respostas que o provedor lê. Duas cópias divergiriam na primeira mudança
 * — e a divergência apareceria como mensagem que entra por um caminho e some
 * pelo outro.
 *
 * A ingestão roda ANTES da resposta para todo evento, menos o que o canal
 * declara em `processaDepoisDeResponder` (hoje: mensagem nova do número
 * oficial). Esse responde 200 assim que o arquivo o guardou e marcou, e é
 * processado no `after()` — o mapa está em
 * `docs/architecture/entrada-que-responde-antes.architecture.json`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { abrirArquivoDoWebhook, fecharArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import { aceitarEntrada, processarDepoisDaResposta } from "@/lib/channels/entrada-aceita";
import {
  handleInboundWebhook,
  inboundPayloadBelongsToSession,
  processaDepoisDeResponder,
  verifyInboundWebhookSignature,
  type InboundWebhookInput,
} from "@/lib/channels/inbound";
import { logger } from "@/lib/logger";

/** Segundos sugeridos ao provedor no `Retry-After` do 503. */
const REENTREGA_EM_SEGUNDOS = 5;

/**
 * Agenda o trabalho para DEPOIS de a resposta sair. `after()` do Next roda no
 * servidor próprio (`next start` / standalone no Docker), e o encerramento
 * gracioso (SIGTERM) espera os pendentes antes de sair. O que um SIGKILL cortar
 * fica no arquivo para o cron `webhook-replay`.
 *
 * O `catch` é cinto: `processarDepoisDaResposta` já não lança, e uma rejeição
 * aqui só viraria log do Next sem contexto.
 */
function agendar(tarefa: () => Promise<void>): void {
  after(async () => {
    try {
      await tarefa();
    } catch (err) {
      logger.error("[webhook-canal] processamento depois da resposta lançou", {
        detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
      });
    }
  });
}

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

  // ─── Responder primeiro, processar depois ──────────────────────────────────
  //
  // O provedor dá por falha a entrega que não responde em poucos segundos e
  // reentrega; a ingestão de uma mensagem passava disso com volume (medido:
  // 368 de 1.304 mensagens em 30 dias com uma tentativa vencida). Para o evento
  // que o canal declara (`processaDepoisDeResponder` — a rota não sabe qual
  // canal é), a resposta sai assim que o arquivo guardou o corpo e marcou a
  // linha como aceita; a ingestão roda no `after()`.
  //
  // O ARQUIVO É A CAIXA DE ENTRADA DURÁVEL: se ele não gravou, não há 200. Um
  // 200 sem a linha marcada entregaria a mensagem a um processamento que morre
  // com o contêiner — e o provedor, que recebeu 200, não reentrega. 503 pede a
  // reentrega, e a reentrega é segura (`23505` vira dedup).
  if (processaDepoisDeResponder(sessao.provider, rawBody)) {
    const arquivoId = arquivo;
    if (arquivoId === null || !(await aceitarEntrada(admin, arquivoId))) {
      // A linha que abriu e não se deixou marcar fecha como recusada: a
      // reentrega abre outra, e esta não pode ficar `received` com cara de
      // pendente. (Sem linha, o fechamento não faz nada.)
      await fecharArquivoDoWebhook(admin, arquivoId, {
        status: "error",
        validSignature: true,
        erro: "nao_aceita_reentrega_pedida",
      });
      logger.warn("[webhook-canal] arquivo indisponível — pedindo a reentrega", {
        organization_id: sessao.organization_id,
        channel_session_id: sessao.id,
        request_id: requestId,
      });
      return fail("upstream_unavailable", "arquivo indisponível — reentregue o evento", 503, {
        requestId,
        headers: { "Retry-After": String(REENTREGA_EM_SEGUNDOS) },
      });
    }
    agendar(async () => {
      await processarDepoisDaResposta(admin, { sessao, rawBody, arquivoId, requestId });
    });
    return ok({ status: "accepted" }, { requestId });
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
