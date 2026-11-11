/**
 * Canal de SMS (#4415) — a conversa com o fornecedor, e só ela.
 *
 * Este arquivo é o ÚNICO lugar que conhece a API do fornecedor de SMS: a URL,
 * o formato do formulário, a assinatura do webhook e os códigos de erro. Fora
 * de `lib/channels/` ninguém cita o nome (invariante 1 da doutrina de
 * restrição de canal); quem envia pergunta capacidades e chama o adapter.
 *
 * Tudo aqui é função pura ou `fetch` com teto de espera — sem banco. A
 * credencial chega pronta de quem chama, e nunca entra numa mensagem de erro:
 * a mensagem é gravada em `messages.error_message` e em log.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const API_BASE = "https://api.twilio.com/2010-04-01";

/** Teto de espera: um fornecedor que pendura a conexão pendura o turno do agente junto. */
const TETO_DE_ESPERA_MS = 20_000;

/** Account SID: `AC` + 32 hexadecimais. Validado antes de virar pedaço de URL. */
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;

/** Número no formato internacional (E.164): `+`, de 8 a 15 dígitos. */
const E164 = /^\+[1-9]\d{7,14}$/;

export interface SmsCredentials {
  accountSid: string;
  authToken: string;
}

export interface SmsEnviado {
  /** Id da mensagem no fornecedor (`SM…`/`MM…`). */
  sid: string;
}

/**
 * O que a recusa do fornecedor quer dizer para o CRM — a única tradução de
 * código numérico para decisão. Quem chama decide pela categoria, não pelo
 * número, para que o número nunca vaze para fora deste arquivo.
 */
export type MotivoDaRecusa =
  /** O destinatário respondeu STOP: a operadora bloqueia e o contato deve ser marcado. */
  | "destinatario_descadastrado"
  /** Pediu para desacelerar: não é falha da mensagem, é para tentar de novo depois. */
  | "desacelerar"
  /** Número de destino inválido ou que não recebe SMS. */
  | "destino_invalido"
  /** Credencial recusada ou conta suspensa: reconectar o canal. */
  | "credencial"
  /** Número de origem não registrado para envio comercial nos EUA (A2P 10DLC). */
  | "remetente_nao_registrado"
  | "outro";

/** Códigos documentados do fornecedor → categoria. O que não está aqui é `outro`. */
const CATEGORIA_DO_CODIGO: Record<number, MotivoDaRecusa> = {
  21610: "destinatario_descadastrado",
  20429: "desacelerar",
  14107: "desacelerar",
  21211: "destino_invalido",
  21614: "destino_invalido",
  21612: "destino_invalido",
  20003: "credencial",
  20005: "credencial",
  30034: "remetente_nao_registrado",
};

export function motivoDaRecusa(codigo: number | null, httpStatus: number): MotivoDaRecusa {
  if (codigo !== null && CATEGORIA_DO_CODIGO[codigo]) return CATEGORIA_DO_CODIGO[codigo];
  if (httpStatus === 429) return "desacelerar";
  if (httpStatus === 401 || httpStatus === 403) return "credencial";
  return "outro";
}

/** Erro de envio com a categoria já resolvida. O texto nunca carrega o token. */
export class SmsRecusado extends Error {
  readonly motivo: MotivoDaRecusa;
  readonly codigo: number | null;
  readonly httpStatus: number;

  constructor(motivo: MotivoDaRecusa, codigo: number | null, httpStatus: number, detalhe: string) {
    super(`sms_send_failed: ${codigo ?? httpStatus} ${detalhe}`.slice(0, 300));
    this.name = "SmsRecusado";
    this.motivo = motivo;
    this.codigo = codigo;
    this.httpStatus = httpStatus;
  }
}

export function numeroE164Valido(numero: string): boolean {
  return E164.test(numero);
}

function autorizacao(creds: SmsCredentials): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`, "utf8").toString("base64")}`;
}

/**
 * Envia um SMS de texto. Devolve o id do fornecedor ou LANÇA `SmsRecusado`.
 *
 * Valida a forma de tudo antes de sair da máquina: um Account SID fora do
 * formato viraria um caminho de URL arbitrário, e número fora do E.164 é
 * recusa certa do outro lado, só que mais cara de diagnosticar.
 */
export async function enviarSms(
  creds: SmsCredentials,
  input: { de: string; para: string; texto: string; avisoDeStatusUrl?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsEnviado> {
  if (!ACCOUNT_SID.test(creds.accountSid)) throw new Error("sms_account_invalid: identificador da conta fora do formato.");
  if (!creds.authToken) throw new Error("sms_not_configured: conta de SMS sem chave de acesso.");
  if (!numeroE164Valido(input.de)) throw new Error("sms_from_invalid: número de origem fora do formato internacional.");
  if (!numeroE164Valido(input.para)) {
    throw new SmsRecusado("destino_invalido", null, 0, "número de destino fora do formato internacional");
  }
  if (input.texto.trim().length === 0) throw new Error("sms_empty_body: mensagem de texto sem corpo.");

  const form = new URLSearchParams({ From: input.de, To: input.para, Body: input.texto });
  if (input.avisoDeStatusUrl) form.set("StatusCallback", input.avisoDeStatusUrl);

  const res = await fetchImpl(`${API_BASE}/Accounts/${creds.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: autorizacao(creds),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(TETO_DE_ESPERA_MS),
  });

  const json = (await res.json().catch(() => null)) as
    | { sid?: unknown; code?: unknown; message?: unknown }
    | null;

  if (!res.ok) {
    const codigo = typeof json?.code === "number" ? json.code : null;
    const detalhe = typeof json?.message === "string" ? json.message : res.statusText;
    throw new SmsRecusado(motivoDaRecusa(codigo, res.status), codigo, res.status, detalhe);
  }
  if (typeof json?.sid !== "string" || json.sid.length === 0) {
    throw new Error("sms_send_without_id: o fornecedor aceitou o envio sem devolver id.");
  }
  return { sid: json.sid };
}

/**
 * Confere que o webhook veio do fornecedor: HMAC-SHA1, com a chave da conta,
 * da URL pública EXATA seguida de cada parâmetro do formulário em ordem
 * alfabética de nome (nome + valor, sem separador), em base64.
 *
 * Falha fechado: sem chave, sem cabeçalho ou tamanho diferente → `false`.
 * A URL tem de ser a mesma configurada no fornecedor (esquema, host, caminho
 * e query) — atrás de proxy, a remontada pela base pública, não a do request.
 */
export function assinaturaDoSmsValida(
  authToken: string | null,
  urlPublica: string,
  params: Record<string, string>,
  cabecalho: string | null,
): boolean {
  if (!authToken || !cabecalho) return false;
  const conteudo =
    urlPublica +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const esperada = createHmac("sha1", authToken).update(conteudo, "utf8").digest("base64");
  const a = Buffer.from(cabecalho, "utf8");
  const b = Buffer.from(esperada, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** O corpo do webhook (form-urlencoded) como mapa simples. Chave repetida: vale a última. */
export function formularioDoWebhook(rawBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) out[k] = v;
  return out;
}

const SmsRecebidoSchema = z.object({
  MessageSid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i),
  AccountSid: z.string().regex(ACCOUNT_SID),
  From: z.string().regex(E164),
  To: z.string().regex(E164),
  Body: z.string().default(""),
  NumMedia: z.coerce.number().int().min(0).default(0),
});

/** Um SMS que chegou, já no vocabulário do CRM. */
export interface SmsRecebido {
  /** Id do fornecedor — a chave do `unique (org, external_id)` em `messages`. */
  externalId: string;
  contaId: string;
  /** Telefone de quem mandou (E.164) — é por ele que o contato é casado. */
  de: string;
  /** O número da empresa que recebeu (E.164) — tem de ser o da conexão. */
  para: string;
  texto: string;
  quantidadeDeMidias: number;
}

export type LeituraDoSms =
  | { ok: true; sms: SmsRecebido }
  | { ok: false; campos: string[] };

/**
 * Lê o webhook de mensagem recebida. Todo dado de fora passa pelo Zod antes
 * de virar contato e mensagem; o que não bate devolve os campos culpados,
 * para o log dizer o que veio errado em vez de "payload inválido".
 */
export function lerSmsRecebido(params: Record<string, string>): LeituraDoSms {
  const r = SmsRecebidoSchema.safeParse(params);
  if (!r.success) {
    return { ok: false, campos: [...new Set(r.error.issues.map((i) => String(i.path[0] ?? "?")))] };
  }
  return {
    ok: true,
    sms: {
      externalId: r.data.MessageSid,
      contaId: r.data.AccountSid,
      de: r.data.From,
      para: r.data.To,
      texto: r.data.Body,
      quantidadeDeMidias: r.data.NumMedia,
    },
  };
}

/**
 * Alfabeto GSM-7 (básico + extensão). Fora dele — emoji, acento que não está
 * na tabela — a mensagem inteira vira UCS-2 e o tamanho por parte cai de 160
 * para 70. Caractere da extensão ocupa duas posições.
 */
const GSM_BASICO =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENSAO = "^{}\\[~]|€\f";

/**
 * Em quantas partes (e portanto quantas cobranças) o texto sai. Uma parte
 * sozinha leva 160 (GSM-7) ou 70 (UCS-2); emendadas, 153 ou 67, porque o
 * cabeçalho de junção ocupa espaço.
 */
export function partesDoSms(texto: string): { partes: number; codificacao: "gsm7" | "ucs2" } {
  let unidades = 0;
  let gsm = true;
  for (const c of texto) {
    if (GSM_BASICO.includes(c)) unidades += 1;
    else if (GSM_EXTENSAO.includes(c)) unidades += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    // UCS-2 conta em unidades de 16 bits: emoji fora do plano básico ocupa duas.
    const u16 = texto.length;
    return { partes: u16 <= 70 ? 1 : Math.ceil(u16 / 67), codificacao: "ucs2" };
  }
  if (unidades === 0) return { partes: 0, codificacao: "gsm7" };
  return { partes: unidades <= 160 ? 1 : Math.ceil(unidades / 153), codificacao: "gsm7" };
}
