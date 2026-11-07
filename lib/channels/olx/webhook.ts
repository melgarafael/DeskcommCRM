/**
 * O CONTRATO DO FIO do chat da OLX — leitura e normalização do payload de
 * entrada (issue #2927).
 *
 * ─── De onde vem cada campo ────────────────────────────────────────────────
 *
 * Documentação usada, sem intermediário:
 *   https://developers.olx.com.br/chat/receive_message.html  (corpo do webhook)
 *   https://developers.olx.com.br/chat/send_message.html     (envio)
 *   https://developers.olx.com.br/chat/oauth_chat.html       (escopo `chat`)
 *
 * O corpo documentado é UM objeto plano, sem envelope e sem lista:
 *
 *   {"chatId","message","senderType","email","name","phone",
 *    "messageTimestamp","messageId","origin","listId"}
 *
 * ─── O que a documentação NÃO diz, e por isso aqui é tolerante ─────────────
 *
 * `senderType` aparece na descrição dos campos como `account` | `system`, e no
 * exemplo do MESMO documento como `buyer`. A doc se contradiz; então quem
 * decide o sentido da mensagem aqui é `origin` (`buyer` = comprador falou,
 * `seller` = o eco do que o vendedor mandou), que é o único campo com descrição
 * coerente nos dois lugares. `senderType` só é usado para descartar aviso de
 * sistema.
 *
 * `messageTimestamp` vem no formato `yyyy-MM-ddThh24:mm:ss.ms` — SEM fuso. Um
 * horário sem fuso é ambíguo por construção; ele é usado como carimbo de
 * exibição e, quando não parseia, cai no relógio do servidor. Não é campo de
 * decisão: nada no ingest depende dele para separar evento repetido (quem faz
 * isso é `messageId`).
 *
 * ─── Por que a leitura é separada do ingest ────────────────────────────────
 *
 * Pelo mesmo motivo de `meta/envelope.ts` e `zernio/envelope.ts`: o contrato é
 * conferido ANTES de qualquer leitura no banco, e a recusa NOMEIA os campos
 * (nunca os valores — o corpo carrega e-mail, telefone e nome do comprador).
 * Aqui a recusa importa mais que nos outros canais: o parser antigo devolvia
 * `null` para o que não era string, o `null` virava "evento sem interesse" e a
 * rota respondia 200 — a mensagem do cliente sumia com carimbo de normalidade.
 */

/** Base do autoservice da OLX — os dois endpoints do chat vivem embaixo dela. */
export const OLX_AUTOSERVICE_BASE = "https://apps.olx.com.br";

/** `POST` aqui com `{textMessage, messageId, chatId}` é o único envio do canal. */
export const OLX_CAMINHO_DE_ENVIO = "/autoservice/v1/chat/send";

/** `POST` aqui com `{"webhook": "<url>"}` registra/atualiza o destino do webhook. */
export const OLX_CAMINHO_DE_WEBHOOK = "/autoservice/v1/chat";

/**
 * Os campos que o payload PRECISA ter, com o tipo que a doc declara. `origin` é
 * obrigatório porque é ele que diz de quem é a mensagem: sem ele não há como
 * separar comprador de eco do vendedor, e escolher por palpite encheria a caixa
 * de entrada com as nossas próprias respostas.
 */
const CAMPOS_OBRIGATORIOS = ["chatId", "message", "messageId", "origin"] as const;

export type LeituraOlx =
  | { ok: true; envelope: Record<string, unknown> }
  | { ok: false; motivo: "json_invalido" }
  | { ok: false; motivo: "contrato_violado"; campos: string[] };

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim().length > 0 ? valor : null;
}

/** O corpo é JSON de um objeto com os campos obrigatórios? Não olha valor nenhum. */
export function lerEnvelopeOlx(rawBody: string): LeituraOlx {
  let bruto: unknown;
  try {
    bruto = JSON.parse(rawBody);
  } catch {
    return { ok: false, motivo: "json_invalido" };
  }
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    return { ok: false, motivo: "contrato_violado", campos: ["<corpo>"] };
  }
  const envelope = bruto as Record<string, unknown>;
  const faltando = CAMPOS_OBRIGATORIOS.filter((campo) => texto(envelope[campo]) === null);
  if (faltando.length > 0) return { ok: false, motivo: "contrato_violado", campos: faltando };
  return { ok: true, envelope };
}

/** A mensagem normalizada — o vocabulário do CRM, não o da OLX. */
export interface MensagemOlx {
  /** `chatId`: a thread. É o endereço de resposta e vira `provider_conversation_id`. */
  chatId: string;
  texto: string;
  /** `messageId`: a chave de idempotência (o `unique (org, external_id)` usa esta). */
  messageId: string;
  /** `origin` cru, para o log e o metadata: `buyer` | `seller`. */
  origin: string;
  senderType: string | null;
  nome: string | null;
  telefone: string | null;
  email: string | null;
  /** `listId`: o anúncio que originou a conversa. Vai para o metadata da mensagem. */
  anuncioId: string | null;
  recebidaEm: Date;
}

/**
 * O carimbo de hora documentado, `yyyy-MM-ddThh24:mm:ss.ms`, NÃO traz fuso (a
 * doc não diz qual, e um horário sem fuso é ambíguo por construção).
 *
 * Duas decisões, explícitas em vez de herdadas do `TZ` do processo:
 *
 *  - sem `Z` e sem deslocamento no fim, o valor é lido como horário de BRASÍLIA
 *    (`-03:00`, sem horário de verão desde 2019). Deixar o `new Date` decidir
 *    faria o MESMO payload virar 14:32 num contêiner em UTC e 17:32 num em BRT —
 *    mensagem carimbada três horas no futuro ou no passado conforme o host, e
 *    ninguém ligaria o sintoma a isto;
 *  - o que não parseia cai no relógio do servidor: é carimbo de EXIBIÇÃO, não
 *    campo de decisão — a idempotência é do `messageId`, não da hora.
 */
const SEM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function dataDaMensagem(valor: unknown): Date {
  const cru = texto(valor);
  if (!cru) return new Date();
  const comFuso = SEM_FUSO.test(cru) ? `${cru}-03:00` : cru;
  const data = new Date(comFuso);
  return Number.isNaN(data.getTime()) ? new Date() : data;
}

/**
 * Normaliza o envelope JÁ validado. `null` quando não é mensagem de gente:
 *
 *   - `origin: "seller"` é o ECO do que nós mesmos mandamos (a doc: "mensagem
 *     originada pelo vendedor"). Deixá-lo entrar criaria uma segunda bolha do
 *     lado do cliente para cada resposta do atendente;
 *   - `senderType: "system"` é aviso da plataforma, não recado de comprador.
 */
export function parseOlxInbound(envelope: Record<string, unknown>): MensagemOlx | null {
  const chatId = texto(envelope.chatId);
  const textoDaMensagem = texto(envelope.message);
  const messageId = texto(envelope.messageId);
  const origin = texto(envelope.origin);
  if (!chatId || !textoDaMensagem || !messageId || !origin) return null;

  const senderType = texto(envelope.senderType);
  if (senderType === "system") return null;
  if (origin !== "buyer") return null;

  return {
    chatId,
    texto: textoDaMensagem,
    messageId,
    origin,
    senderType,
    nome: texto(envelope.name),
    telefone: texto(envelope.phone),
    email: texto(envelope.email),
    anuncioId: texto(envelope.listId),
    recebidaEm: dataDaMensagem(envelope.messageTimestamp),
  };
}

/**
 * O evento é de mensagem do comprador? Puro, para o chamador distinguir
 * "não interessa" de "não é contrato" sem repetir a régua.
 */
export function eventoDeComprador(envelope: Record<string, unknown>): boolean {
  return parseOlxInbound(envelope) !== null;
}
