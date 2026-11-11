/**
 * O segredo de uma instalação de módulo `connected` e a assinatura que prova que quem busca o token
 * o conhece (spec 33, F2).
 *
 * ── O que há aqui ───────────────────────────────────────────────────────────
 *
 * - `gerarSegredo` / `cifrarSegredo` / `decifrarSegredo`: o segredo (32 bytes, base64url) nasce no
 *   servidor e só existe em claro no escopo de quem o gerou. No banco fica cifrado (AES-256-GCM, a
 *   mesma cifra e a mesma chave `AI_CRED_AES_KEY` das chaves de IA, `lib/crypto/aes_gcm.ts`).
 * - `assinar` / `verificarAssinatura`: HMAC-SHA256 em hex sobre `${organizationId}.${timestamp}.${nonce}`.
 *   A organização entra na assinatura, então a assinatura de uma não vale para outra.
 * - `carimboDentroDaJanela`: o carimbo de tempo só vale dentro de `JANELA_DO_CARIMBO_MS`.
 *
 * ── Regras que não mudam ────────────────────────────────────────────────────
 *
 * - O segredo NUNCA vai para log, auditoria, recibo (`extension_operations.result`) nem mensagem de
 *   erro. Os erros desta unidade têm frase fixa.
 * - Sem `AI_CRED_AES_KEY` utilizável não se cifra nem se decifra: lança `extension_secret_key_missing`.
 *   Quem instala um módulo `connected` confere isto ANTES de gravar a instalação
 *   (`garantirChaveDeCifra`).
 * - `verificarAssinatura` nunca lança: assinatura malformada (tamanho errado, não-hex) é só `false`.
 *
 * Módulo puro (sem banco, sem `server-only`): o teste o exercita direto.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

/** A tolerância do relógio entre o módulo e o host: 5 minutos para cada lado. */
export const JANELA_DO_CARIMBO_MS = 5 * 60 * 1000;

export const CODIGO_CHAVE_DE_CIFRA_AUSENTE = "extension_secret_key_missing";

/**
 * A chave de cifra do servidor não está configurada (ou não presta). Frase fixa e em português: é
 * a que a tela mostra, e nada dela vem do segredo nem do valor da chave.
 */
export class ChaveDeCifraAusenteError extends Error {
  readonly code = CODIGO_CHAVE_DE_CIFRA_AUSENTE;

  constructor() {
    super(
      "Falta configurar a chave de cifra do servidor (AI_CRED_AES_KEY). Configure-a e repita o pedido.",
    );
    this.name = "ChaveDeCifraAusenteError";
  }
}

export function ehChaveDeCifraAusente(error: unknown): error is ChaveDeCifraAusenteError {
  return error instanceof ChaveDeCifraAusenteError;
}

/**
 * Confere que a chave de cifra existe e presta, cifrando um byte de prova. Lança
 * `ChaveDeCifraAusenteError` quando falta ou está malformada (não tem 32 bytes em base64).
 */
export function garantirChaveDeCifra(): void {
  try {
    encryptKey("x");
  } catch {
    throw new ChaveDeCifraAusenteError();
  }
}

/** 32 bytes aleatórios em base64url (43 caracteres, sem preenchimento). */
export function gerarSegredo(): string {
  return randomBytes(32).toString("base64url");
}

const VERSAO_DA_CIFRA = "v1";

/** `v1.<iv>.<tag>.<texto cifrado>`, cada parte em base64url. Cabe numa coluna `text`. */
export function cifrarSegredo(segredo: string): string {
  garantirChaveDeCifra();
  const { ciphertext, iv, tag } = encryptKey(segredo);
  return [
    VERSAO_DA_CIFRA,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Inverso de `cifrarSegredo`. Chave ausente lança `extension_secret_key_missing`; valor guardado
 * ilegível ou adulterado lança um erro de frase fixa, sem eco do conteúdo.
 */
export function decifrarSegredo(cifrado: string): string {
  garantirChaveDeCifra();
  const partes = cifrado.split(".");
  if (partes.length !== 4 || partes[0] !== VERSAO_DA_CIFRA) {
    throw new Error("Segredo guardado em formato ilegível.");
  }
  try {
    return decryptKey({
      iv: Buffer.from(partes[1]!, "base64url"),
      tag: Buffer.from(partes[2]!, "base64url"),
      ciphertext: Buffer.from(partes[3]!, "base64url"),
    });
  } catch {
    throw new Error("Segredo guardado não pôde ser aberto.");
  }
}

export interface EntradaDaAssinatura {
  organizationId: string;
  /** Carimbo enviado pelo módulo (milissegundos desde 1970, como texto ou número). */
  timestamp: string | number;
  nonce: string;
}

function calcularAssinatura(segredo: string, entrada: EntradaDaAssinatura): Buffer {
  return createHmac("sha256", segredo)
    .update(`${entrada.organizationId}.${entrada.timestamp}.${entrada.nonce}`)
    .digest();
}

/** HMAC-SHA256 em hex minúsculo sobre `${organizationId}.${timestamp}.${nonce}`. */
export function assinar(segredo: string, entrada: EntradaDaAssinatura): string {
  return calcularAssinatura(segredo, entrada).toString("hex");
}

const HEX_DE_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * Compara em tempo constante. O comprimento e o alfabeto são conferidos ANTES de
 * `timingSafeEqual` (que lança em tamanhos diferentes): assinatura de outro tamanho ou não-hex é
 * `false`, nunca exceção.
 */
export function verificarAssinatura(
  segredo: string,
  entrada: EntradaDaAssinatura,
  assinatura: string,
): boolean {
  try {
    if (typeof assinatura !== "string" || !HEX_DE_SHA256.test(assinatura)) return false;
    const recebida = Buffer.from(assinatura, "hex");
    const esperada = calcularAssinatura(segredo, entrada);
    if (recebida.length !== esperada.length) return false;
    return timingSafeEqual(recebida, esperada);
  } catch {
    return false;
  }
}

/**
 * O carimbo vale quando a distância até o relógio do host é de NO MÁXIMO `JANELA_DO_CARIMBO_MS`,
 * para o passado ou para o futuro. A borda é INCLUSIVA: exatamente 5 min passa; 5 min + 1 ms não.
 * Carimbo que não é número finito não vale.
 */
export function carimboDentroDaJanela(timestampMs: number, agoraMs: number): boolean {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(agoraMs)) return false;
  return Math.abs(agoraMs - timestampMs) <= JANELA_DO_CARIMBO_MS;
}
