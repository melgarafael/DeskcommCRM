/**
 * Geração e hash dos segredos do OAuth do MCP.
 *
 * Nada aqui é guardado em claro: o banco recebe só SHA-256 (bytea), como os
 * `dsk_` de `api_tokens` (anti-pattern 13). O plaintext sai UMA vez, na
 * resposta ao cliente.
 *
 * Prefixos distintos por tipo — `dcc_` cliente, `dcs_` segredo do cliente,
 * `dco_` código, `dsr_` refresh — para um segredo colado no lugar errado ser
 * reconhecível no log de quem depura, e o access token é `dsk_`, porque É um
 * token de `api_tokens` e o `/api/mcp` o valida pelo caminho de sempre.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256(valor: string): Buffer {
  return createHash("sha256").update(valor).digest();
}

/** Literal bytea para o PostgREST (`\x<hex>`), como em `api_tokens`. */
export function byteaDoHash(valor: string): string {
  return `\\x${sha256(valor).toString("hex")}`;
}

export function novoClientId(): string {
  // 24 bytes → 32 caracteres base64url, o formato do CHECK da tabela.
  return `dcc_${randomBytes(24).toString("base64url")}`;
}

export function novoSegredoDeCliente(): string {
  return `dcs_${randomBytes(32).toString("base64url")}`;
}

export function novoCodigo(): string {
  return `dco_${randomBytes(32).toString("base64url")}`;
}

export function novoRefresh(): string {
  return `dsr_${randomBytes(32).toString("base64url")}`;
}

/** O mesmo formato de `POST /api/v1/settings/api-tokens`: `dsk_<8 hex>_<segredo>`. */
export function novoAccessToken(): { prefixo: string; plaintext: string } {
  const prefixo = `dsk_${randomBytes(4).toString("hex")}`;
  return { prefixo, plaintext: `${prefixo}_${randomBytes(32).toString("base64url")}` };
}

/**
 * Confere um segredo apresentado contra o bytea guardado, em tempo constante.
 * O PostgREST devolve bytea como `\x<hex>`.
 */
export function segredoConfere(apresentado: string, guardado: string | null | undefined): boolean {
  if (!guardado || !/^\\x[0-9a-f]{64}$/i.test(guardado)) return false;
  const esperado = Buffer.from(guardado.slice(2), "hex");
  return timingSafeEqual(sha256(apresentado), esperado);
}
