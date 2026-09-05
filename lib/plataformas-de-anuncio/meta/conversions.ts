/**
 * O transporte de conversões da plataforma de anúncios da Meta.
 *
 * ESTE é o único arquivo do repo, fora de `lib/channels/`, que pode escrever o
 * nome do endpoint — e é por isso que ele existe separado: tudo que sabe o
 * formato do fio mora aqui, e some daqui para dentro se a plataforma mudar.
 *
 * ─── O que a plataforma exige, e o que ela perdoa ───────────────────────────
 *
 * Três regras que não são opinião e que quebram em produção quando ignoradas:
 *
 * 1. `Purchase` exige `value` E `currency`. Não é opcional. Mandar sem valor é
 *    rejeição; mandar `0` para "resolver" é pior, porque é ACEITO e ensina ao
 *    otimizador que a venda não vale nada. Por isso o chamador nem chega aqui
 *    sem valor — ele registra `sem_valor` e deixa visível na tela.
 *
 * 2. Evento com mais de 7 dias é recusado. O `event_time` é o `closed_at` do
 *    lead, então um backlog de drain maior que isso não vira "atrasado", vira
 *    PERDIDO. O teto está aqui e não no chamador porque o número é da
 *    plataforma, não da nossa feature.
 *
 * 3. Identidade. Para conversão vinda de anúncio clique-para-WhatsApp, o
 *    `ctwa_clid` é o que liga a venda ao clique — é ele que carrega a atribuição,
 *    e o telefone hasheado só reforça. Sem o clique não há o que reportar, e é
 *    isso que o chamador chama de `sem_atribuicao`.
 *
 * ─── Por que `business_messaging` e não `website` ───────────────────────────
 *
 * `action_source` descreve ONDE a conversão aconteceu, e a plataforma valida a
 * combinação: `business_messaging` é o que aceita `ctwa_clid` como identidade e
 * exige o `messaging_channel` junto. Declarar `website` passaria no envio e a
 * conversão não seria atribuída ao anúncio — o pior desfecho possível, porque
 * devolve 200 e não produz efeito nenhum.
 */
import { createHash } from "node:crypto";

import { logger } from "@/lib/logger";
import type {
  ConversaoOffline,
  CredencialDeConversao,
  ResultadoDeEnvio,
  TransporteDeConversao,
} from "../types";

/**
 * Fixada no código, e não em env nova (item 9 do DoD pede env em dois lugares e
 * este eixo não deve herdar a variável do canal de mensagem — são credenciais e
 * ciclos de vida diferentes). Mesma versão que o transporte de mensagens usa
 * como default hoje, para a instalação não conviver com duas.
 */
const VERSAO_DA_API = "v22.0";

/** O teto da plataforma. Evento mais velho que isto é recusado. */
const IDADE_MAXIMA_MS = 7 * 24 * 60 * 60 * 1000;

const TEMPO_LIMITE_MS = 10_000;

/** SHA-256 hex do valor normalizado, como a plataforma exige para dado pessoal. */
function hash(valor: string): string {
  return createHash("sha256").update(valor.trim().toLowerCase()).digest("hex");
}

/**
 * Um 4xx pode ser das duas naturezas, e a diferença decide retry vs. avisar o
 * humano. O código 190 (e a família 102/463) é token — humano. O 613 é
 * throttle: 4xx que se resolve sozinho, e tratá-lo como permanente faria o
 * sistema desistir de uma venda por causa de um pico de tráfego.
 */
function classifica4xx(codigo: number | null, mensagem: string): ResultadoDeEnvio {
  if (codigo === 613 || codigo === 80004) {
    return { tipo: "transitorio", detalhe: `limite de chamadas (${codigo}): ${mensagem}` };
  }
  return { tipo: "permanente", detalhe: mensagem };
}

async function enviar(
  credencial: CredencialDeConversao,
  conversao: ConversaoOffline,
): Promise<ResultadoDeEnvio> {
  const idadeMs = Date.now() - conversao.ocorridoEm.getTime();
  if (idadeMs > IDADE_MAXIMA_MS) {
    const dias = Math.floor(idadeMs / (24 * 60 * 60 * 1000));
    return {
      tipo: "permanente",
      detalhe:
        `evento com ${dias} dias — a plataforma recusa acima de 7. ` +
        `A venda fechou em ${conversao.ocorridoEm.toISOString()} e não pode mais ser reportada.`,
    };
  }

  const userData: Record<string, unknown> = {
    ctwa_clid: conversao.cliqueDeOrigem,
  };
  // Array de propósito: o formato aceita múltiplos valores por campo, e mandar
  // string crua onde ele espera lista é aceito com aviso e ignorado no match.
  if (conversao.telefone) userData.ph = [hash(conversao.telefone)];

  const corpo: Record<string, unknown> = {
    data: [
      {
        event_name: conversao.evento,
        // Segundos, não milissegundos. Em ms o evento cai a ~55 mil anos no
        // futuro, e a resposta é 200 — some sem erro.
        event_time: Math.floor(conversao.ocorridoEm.getTime() / 1000),
        event_id: conversao.eventoId,
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: userData,
        custom_data: {
          value: conversao.valorCentavos / 100,
          currency: conversao.moeda.toUpperCase(),
        },
      },
    ],
  };
  if (credencial.testEventCode) corpo.test_event_code = credencial.testEventCode;

  const url =
    `https://graph.facebook.com/${VERSAO_DA_API}/` +
    `${encodeURIComponent(credencial.datasetId)}/events`;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // No header, nunca na query string: token em URL vaz(a) para log de
        // proxy e para o Sentry junto do breadcrumb da request.
        authorization: `Bearer ${credencial.accessToken}`,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return {
      tipo: "transitorio",
      detalhe: erro instanceof Error ? erro.message : "falha de rede",
    };
  }

  if (resposta.ok) return { tipo: "ok" };

  const texto = await resposta.text().catch(() => "");
  let codigo: number | null = null;
  let mensagem = texto.slice(0, 400);
  try {
    const json = JSON.parse(texto) as { error?: { code?: number; message?: string } };
    if (typeof json.error?.code === "number") codigo = json.error.code;
    if (json.error?.message) mensagem = json.error.message;
  } catch {
    // Corpo não-JSON num erro é o caso de gateway/WAF no meio. Fica o texto cru.
  }

  logger.warn("[conversoes.meta] envio recusado", {
    status: resposta.status,
    codigo,
    leadId: conversao.leadId,
  });

  if (resposta.status >= 500) {
    return { tipo: "transitorio", detalhe: `${resposta.status}: ${mensagem}` };
  }
  return classifica4xx(codigo, mensagem);
}

export const transporteMeta: TransporteDeConversao = {
  plataforma: "meta_ads",
  enviar,
};

/** Exportados para o teste poder vigiar as regras sem falar com a rede. */
export const INTERNOS = { hash, classifica4xx, IDADE_MAXIMA_MS, VERSAO_DA_API } as const;
