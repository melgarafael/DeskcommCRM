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
 *    e o telefone hasheado só reforça. A exceção é quem veio de anúncio para
 *    uma PÁGINA (UTM da Meta, sem clique): aí o telefone é a identidade, e a
 *    origem declarada muda (ver abaixo). Sem nenhum dos dois, é recusa.
 *
 * 4. Página ou WABA (#2098). No mesmo evento `business_messaging` do canal
 *    `whatsapp`, a Meta exige `user_data.page_id` OU
 *    `user_data.whatsapp_business_account_id` — sem eles ela recusa com
 *    error_subcode 2804116 ("Falta a identificação da Página ou da conta do
 *    WhatsApp Business") e NENHUMA venda clique-para-WhatsApp passava. Os ids
 *    vêm da credencial (`meta/identidade.ts`, gravados pela tela de
 *    Conversões); o transporte manda o que existir e NUNCA inventa — id
 *    errado não é recusa melhor, é evento atribuído à conta de outra pessoa.
 *    Quando não há id, o envio segue e a recusa é da Meta; a frase dela vai
 *    para o `detail` do livro-razão, e não o "Invalid parameter" genérico.
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

import { VERSAO_PADRAO_DA_GRAPH } from "@/lib/graph-version";
import { logger } from "@/lib/logger";

import { baseDaGraphDeAnuncio } from "./graph-base";
import type {
  ConversaoOffline,
  CredencialDeConversao,
  ResultadoDeEnvio,
  TransporteDeConversao,
} from "../types";

/**
 * Fixada no código, e não em env nova (item 9 do DoD pede env em dois lugares e
 * este eixo não deve herdar a variável do canal de mensagem — são credenciais e
 * ciclos de vida diferentes). Referencia o número do módulo único
 * (`lib/graph-version.ts`) em vez de copiá-lo: o eixo de anúncio usa a MESMA
 * versão do transporte de mensagens, mas não a variável dele.
 */
const VERSAO_DA_API = VERSAO_PADRAO_DA_GRAPH;

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
  // Dois formatos e só dois: a compra, que exige valor (regra 1), e o evento de
  // ETAPA, que sai com o nome padrão escolhido na regra e sem valor — o negócio
  // ainda não foi vendido, e um valor ali ensinaria receita que não existiu.
  const ehCompra = conversao.evento === "Purchase";
  const nomeNoFio = ehCompra ? "Purchase" : conversao.eventoNaPlataforma?.trim();
  if (ehCompra ? conversao.valorCentavos === null : !nomeNoFio)
    return {
      tipo: "permanente",
      detalhe: "Este transporte aceita compras com valor ou eventos de etapa com o nome da Meta.",
    };
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

  // Com clique: anúncio clique-para-WhatsApp, `business_messaging` + `ctwa_clid`.
  // Sem clique: a pessoa veio de anúncio para a PÁGINA e a venda fechou no CRM.
  // `business_messaging` sem `ctwa_clid` é recusado, e `website` exige dados do
  // navegador que o CRM não tem — `system_generated` é a origem declarada para
  // venda registrada em sistema, casada pelo telefone em hash.
  const comClique = conversao.cliqueDeOrigem.trim() !== "";
  if (!comClique && !conversao.telefone) {
    return {
      tipo: "permanente",
      detalhe:
        "Sem o clique do anúncio e sem telefone no contato, a Meta não tem como reconhecer o cliente.",
    };
  }

  const userData: Record<string, unknown> = comClique ? { ctwa_clid: conversao.cliqueDeOrigem } : {};
  // ─── Página ou WABA, só no clique-para-WhatsApp (#2098) ────────────────────
  //
  // A Meta cobra UM dos dois apenas quando a origem é `business_messaging` +
  // canal `whatsapp`. No caminho da página (`system_generated`) os ids não são
  // exigidos, e mandá-los lá acrescentaria dado que ninguém pediu.
  //
  // UM por envio, não os dois: a plataforma pede "o que estiver vinculado ao
  // conjunto de dados", então mandar o par inteiro exibiria um id que talvez
  // não seja deste dataset — e a página é a identidade do clique. A WABA entra
  // só quando não há página. Sem nenhum dos dois: nada é acrescentado, o
  // evento sai como antes e a recusa (com a frase da Meta) fica no livro-razão.
  if (comClique) {
    const pageId = credencial.meta?.pageId ?? null;
    const wabaId = credencial.meta?.whatsappBusinessAccountId ?? null;
    if (pageId) userData.page_id = pageId;
    else if (wabaId) userData.whatsapp_business_account_id = wabaId;
    else
      logger.warn("[conversoes.meta] sem page_id nem whatsapp_business_account_id", {
        leadId: conversao.leadId,
        organizationId: conversao.organizationId,
        motivo: "identidade_ausente_em_settings_conversions",
      });
  }

  // Array de propósito: o formato aceita múltiplos valores por campo, e mandar
  // string crua onde ele espera lista é aceito com aviso e ignorado no match.
  if (conversao.telefone) userData.ph = [hash(conversao.telefone)];

  const customData: Record<string, unknown> = {};
  if (ehCompra && conversao.valorCentavos !== null) {
    customData.value = conversao.valorCentavos / 100;
    customData.currency = conversao.moeda.toUpperCase();
  }

  const corpo: Record<string, unknown> = {
    data: [
      {
        event_name: nomeNoFio,
        // Segundos, não milissegundos. Em ms o evento cai a ~55 mil anos no
        // futuro, e a resposta é 200 — some sem erro.
        event_time: Math.floor(conversao.ocorridoEm.getTime() / 1000),
        event_id: conversao.eventoId,
        ...(comClique
          ? { action_source: "business_messaging", messaging_channel: "whatsapp" }
          : { action_source: "system_generated" }),
        user_data: userData,
        ...(Object.keys(customData).length > 0 ? { custom_data: customData } : {}),
      },
    ],
  };
  if (credencial.testEventCode) corpo.test_event_code = credencial.testEventCode;

  const url =
    `${baseDaGraphDeAnuncio()}/${encodeURIComponent(credencial.datasetId)}/events`;

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

  if (resposta.ok) {
    const corpo: unknown = await resposta.json().catch(() => null);
    if (
      corpo &&
      typeof corpo === "object" &&
      "events_received" in corpo &&
      corpo.events_received === 1
    ) {
      return { tipo: "ok" };
    }
    return { tipo: "transitorio", detalhe: "A plataforma não confirmou o recebimento do evento." };
  }

  const texto = await resposta.text().catch(() => "");
  let codigo: number | null = null;
  let mensagem = texto.slice(0, 400);
  try {
    const json = JSON.parse(texto) as {
      error?: {
        code?: number;
        message?: string;
        error_user_title?: string;
        error_user_msg?: string;
      };
    };
    if (typeof json.error?.code === "number") codigo = json.error.code;
    if (json.error?.message) mensagem = json.error.message;
    // A frase QUE A META MOSTRA AO USUÁRIO (#2098). O `message` dela é o
    // "Invalid parameter" que não diz nada — foi exatamente isso que escondeu
    // o page_id faltando por quanto tempo. Com `error_user_title` +
    // `error_user_msg` o `detail` do livro-razão passa a nomear a causa, que é
    // o que quem opera consegue corrigir. Cortado em 400, como o texto cru.
    if (json.error?.error_user_msg || json.error?.error_user_title) {
      const titulo = json.error.error_user_title?.trim();
      const frase = json.error.error_user_msg?.trim();
      mensagem = [mensagem, titulo, frase].filter(Boolean).join(" — ").slice(0, 400);
    }
  } catch {
    // Corpo não-JSON num erro é o caso de gateway/WAF no meio. Fica o texto cru.
  }

  logger.warn("[conversoes.meta] envio recusado", {
    status: resposta.status,
    codigo,
    leadId: conversao.leadId,
  });

  if (resposta.status === 429 || resposta.status >= 500) {
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
