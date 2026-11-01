/**
 * O que o webhook do Telegram TRAZ e como se prova que é dele — módulo puro.
 *
 * A divisão é a mesma do canal intermediado (`../zernio/webhook.ts` ×
 * `../zernio/ingest.ts`): o que DECIDE dá para provar sem banco, e o que ESCREVE
 * mora no vizinho.
 *
 * ─── A exceção à regra "webhook com HMAC", e por que ela é segura ───────────
 *
 * O Telegram não assina o corpo (é a pergunta 1 da issue #3440, respondida pela
 * própria plataforma): quem prova a origem é o `secret_token` que a instalação
 * inventa e entrega no `setWebhook`, e que volta no cabeçalho
 * `X-Telegram-Bot-Api-Secret-Token` de todo update. Duas coisas fazem isso valer
 * a exceção:
 *
 *   1. o segredo é NOSSO, aleatório e por sessão — não é um literal de
 *      documentação que todo mundo conhece;
 *   2. ele é comparado em TEMPO CONSTANTE (`timingSafeEqual`), porque um `===`
 *      vaza o prefixo certo pelo tempo de resposta.
 *
 * Somado ao `webhook_path_token` do caminho (que resolve a sessão e a
 * organização ANTES de qualquer leitura do corpo), o par é o mesmo nível de
 * garantia do HMAC: sem um dos dois, o atacante não chega ao `ingest`.
 *
 * `timingSafeEqual` EXIGE buffers do mesmo tamanho — comparar tamanhos antes com
 * `===` é o caminho normal e não vaza nada de útil (o tamanho do segredo não é
 * segredo; ele está no `.sql` que criou a linha).
 */
import { timingSafeEqual } from "node:crypto";

/** O cabeçalho que o Telegram devolve com o `secret_token` do `setWebhook`. */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * O host da Bot API. Público e um só para o mundo — por isso o padrão é o real,
 * e a instalação que não configura nada continua falando com ele.
 *
 * O override por `TELEGRAM_API_BASE_URL` existe pela mesma razão do
 * `META_GRAPH_BASE_URL` e do `ZERNIO_API_BASE_URL`: sem um host apontável não
 * há prova em tela do canal (receptor local), e o caminho de envio fica
 * coberto só por dublê de `fetch`. É decisão da INSTALAÇÃO, não da organização —
 * o token vai no CAMINHO de cada chamada (`/bot<token>/<método>`), então deixá-lo
 * por tenant mandaria o segredo de um pelo host que o outro escolheu.
 */
const BASE_PADRAO_DA_BOT_API = "https://api.telegram.org";

/** A variável que aponta a base para outro lugar (prova em tela, homólogo). */
const CHAVE_DA_BASE = "TELEGRAM_API_BASE_URL";

/**
 * A base da Bot API **desta instalação**, sem barra no fim.
 *
 * `||` e não `??`, com o `trim()` junto — a diferença é o bug inteiro: o
 * `.env.example` entrega a chave VAZIA, e string vazia é valor para o `??`.
 * Valor sem esquema absoluto (`api.telegram.org`) montaria `/bot<token>/…` sem
 * host e o `fetch` lançaria `TypeError: Failed to parse URL`; os dois casos caem
 * no host real em vez de virar exceção.
 */
export function telegramApiBase(): string {
  const daVariavel = process.env[CHAVE_DA_BASE]?.trim();
  if (!daVariavel) return BASE_PADRAO_DA_BOT_API;
  const aceita = baseAceita(daVariavel);
  if (aceita) return aceita;
  // Recusa ABERTA no log, fechada na ação: o valor ruim não derruba o envio e
  // não some em silêncio — é a mesma doutrina de `hostAceito` na Graph.
  console.warn(
    `[telegram] ${CHAVE_DA_BASE}="${daVariavel}" não é uma base http(s) absoluta — usando a Bot API real.`,
  );
  return BASE_PADRAO_DA_BOT_API;
}

/** O que a variável aponta, ou `null` quando não serve como base. */
function baseAceita(valor: string): string | null {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    return null;
  }
  // `new URL` aceita `ftp:` e `file:`; destino de chamada que aceitasse isso é
  // pior do que não ter override.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // Consulta e fragmento não fazem parte de uma base; barra no fim é aparada
  // para não virar `//bot<token>` depois.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * O update veio do Telegram DESTA sessão?
 *
 * Falha fechado em todos os caminhos: sem segredo gravado, sem cabeçalho, ou com
 * tamanho diferente, a resposta é `false`. Segredo curto demais é lixo de
 * decifra/placeholder e também não vale — o mesmo piso do `inbound.ts`.
 */
export function verifyTelegramSecretToken(header: string | null, secret: string | null): boolean {
  if (!header || !secret || secret.length < 16) return false;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Uma mensagem de texto que o bot recebeu, já no vocabulário do CRM. */
export interface TelegramInbound {
  /** `tg:<robô>:<conversa>:<mensagem>` — a chave do `unique (org, external_id)`. */
  externalId: string;
  /** `chat.id` — é o que endereça a resposta (`sendMessage.chat_id`). */
  chatId: string;
  /** `from.id` — a pessoa; entra em `contacts.social_identity`. */
  userId: string;
  text: string;
  /** Nome para a ficha: primeiro + último, ou o `@username`. */
  displayName: string | null;
  /** `message.date` (epoch em segundos) convertido — a hora em que o cliente escreveu. */
  sentAt: string;
}

export type TelegramRead =
  | { ok: true; update: TelegramInbound }
  /** JSON válido, mas fora do que a v1 atende (grupo, mídia, callback, edição). */
  | { ok: false; motivo: "sem_interesse"; detalhe: string }
  | { ok: false; motivo: "json_invalido"; detalhe: string };

/**
 * O id canônico de uma mensagem: `tg:<robô>:<conversa>:<mensagem>`.
 *
 * O ROBÔ na chave não é enfeite: o `message_id` é único DENTRO de uma conversa
 * de um bot, e não na instalação. Sem ele, duas organizações (ou dois bots da
 * mesma organização) que recebessem a mensagem 42 do mesmo `chat_id` colidiriam
 * no `unique (organization_id, external_id)` e a segunda seria descartada como
 * duplicata — mensagem de um cliente sumindo com o carimbo de "já estava aqui".
 */
export function telegramExternalId(
  botId: string,
  chatId: string,
  messageId: number | string,
): string {
  return `tg:${botId}:${chatId}:${messageId}`;
}

/**
 * `contacts.social_identity` do Telegram: `telegram:<robô>:<usuário>`.
 *
 * Mesmo molde da 0368 (redes sociais nativas): a identidade é opaca, não é
 * telefone, e vive num campo próprio — nunca em `wa_identity`, que o resto do
 * sistema lê como WhatsApp.
 */
export function telegramIdentity(botId: string, userId: string): string {
  return `telegram:${botId}:${userId}`;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim().length > 0 ? valor : null;
}

function idDe(valor: unknown): string | null {
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return texto(valor);
}

/**
 * Lê um update do Telegram.
 *
 * ─── O que a v1 atende, e por que o resto é `sem_interesse` ──────────────────
 *
 * Só `message` de conversa PRIVADA com texto. Grupo e canal estão fora da v1
 * (`groups: "none"` na capability) e ingeri-los criaria uma conversa que o
 * produto não sabe atender; mídia é a T2; `edited_message`/`callback_query` são
 * correção/interação, não mensagem nova.
 *
 * Recusar AQUI, e não no `ingest`, é o que faz a rota responder 200 com motivo
 * em vez de 500: o Telegram REENTREGA o que não recebe 200 — um grupo que
 * entrasse em laço de reentrega seria uma tempestade por um evento que nunca
 * vamos querer.
 */
export function readTelegramUpdate(payload: unknown, botId: string): TelegramRead {
  // Array também é `typeof === "object"`, e nenhum update do Telegram é lista:
  // tratar `[]` como envelope faria o caminho seguir com campos undefined em vez
  // de recusar o corpo na porta.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, motivo: "json_invalido", detalhe: "corpo não é objeto" };
  }
  const update = payload as Record<string, unknown>;
  const msg = update.message;
  if (!msg || typeof msg !== "object") {
    // Pode ser `edited_message`, `callback_query`, `my_chat_member`… A v1 não
    // atende nenhum; responder 200 é o certo (não queremos reentrega).
    const tipo = Object.keys(update).find((k) => k !== "update_id");
    return { ok: false, motivo: "sem_interesse", detalhe: `update.${tipo ?? "desconhecido"}` };
  }

  const m = msg as Record<string, unknown>;
  const chat = m.chat && typeof m.chat === "object" ? (m.chat as Record<string, unknown>) : null;
  const de = m.from && typeof m.from === "object" ? (m.from as Record<string, unknown>) : null;
  const chatId = idDe(chat?.id);
  if (!chatId) return { ok: false, motivo: "json_invalido", detalhe: "message.chat.id" };
  if (chat?.type !== "private") {
    return { ok: false, motivo: "sem_interesse", detalhe: `chat.type=${String(chat?.type)}` };
  }
  // O bot recusando e recebendo de outro bot não é atendimento.
  if (de?.is_bot === true) return { ok: false, motivo: "sem_interesse", detalhe: "from.is_bot" };

  const userId = idDe(de?.id);
  if (!userId) return { ok: false, motivo: "json_invalido", detalhe: "message.from.id" };
  const messageId = idDe(m.message_id);
  if (!messageId) return { ok: false, motivo: "json_invalido", detalhe: "message.message_id" };

  // Mídia (foto, documento, áudio, voz) chega com `caption` ou sem nada. A v1
  // não a persiste, e fingir que a legenda é a mensagem inteira perderia o
  // anexo em silêncio. Fica para a T2, declarado.
  const text = texto(m.text);
  if (!text) {
    const tipoDeMidia = [
      "photo",
      "document",
      "audio",
      "voice",
      "video",
      "video_note",
      "sticker",
      "location",
      "contact",
    ].find((k) => m[k] !== undefined);
    return { ok: false, motivo: "sem_interesse", detalhe: tipoDeMidia ?? "sem_texto" };
  }

  const nome = [texto(de?.first_name), texto(de?.last_name)].filter(Boolean).join(" ");
  const displayName = nome || texto(de?.username);
  const segundos = typeof m.date === "number" && Number.isFinite(m.date) ? m.date : null;

  return {
    ok: true,
    update: {
      externalId: telegramExternalId(botId, chatId, messageId),
      chatId,
      userId,
      text,
      displayName,
      sentAt: segundos ? new Date(segundos * 1000).toISOString() : new Date().toISOString(),
    },
  };
}
