/**
 * Cifra de segredo de terceiro em TRÊS colunas (`<p>_encrypted`, `<p>_iv`,
 * `<p>_tag`) — a forma de `segredo.ts`, generalizada por prefixo para as
 * tabelas dos servidores MCP por agente (chave, `client_secret`) e das
 * credenciais por contato (access token, refresh token, `code_verifier`).
 *
 * Mesma cifra das chaves de IA (`encryptKey`, AES-256-GCM, `AI_CRED_AES_KEY`):
 * reimplementar o formato faria os caminhos divergirem no primeiro ajuste, e o
 * ajuste que divergiria seria o de segurança. O plaintext só existe no escopo
 * da chamada; quem abre devolve `null` quando a coluna falta ou a cifra não
 * abre (chave de instalação trocada), e `null` significa "sem segredo".
 */
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

export type ColunasCifradas<P extends string> = {
  [K in `${P}_encrypted` | `${P}_iv` | `${P}_tag`]: string;
};

/** Plaintext → as três colunas, no formato `\xHEX` que o PostgREST aceita em `bytea`. */
export function cifrar<P extends string>(prefixo: P, segredo: string): ColunasCifradas<P> {
  const c = encryptKey(segredo);
  return {
    [`${prefixo}_encrypted`]: bufToBytea(c.ciphertext),
    [`${prefixo}_iv`]: bufToBytea(c.iv),
    [`${prefixo}_tag`]: bufToBytea(c.tag),
  } as ColunasCifradas<P>;
}

/** O `last4` de um segredo — a única parte que a tela pode ver. */
export function ultimos4(segredo: string): string {
  return segredo.slice(-4);
}

/** As três colunas em `NULL` — apagar, nunca gravar string vazia em `bytea`. */
export function apagado<P extends string>(prefixo: P): { [K in keyof ColunasCifradas<P>]: null } {
  return {
    [`${prefixo}_encrypted`]: null,
    [`${prefixo}_iv`]: null,
    [`${prefixo}_tag`]: null,
  } as { [K in keyof ColunasCifradas<P>]: null };
}

/** Colunas → plaintext, ou `null`. NUNCA lança. */
export function abrir(prefixo: string, linha: Record<string, unknown> | null | undefined): string | null {
  if (!linha) return null;
  const ciphertext = linha[`${prefixo}_encrypted`];
  const iv = linha[`${prefixo}_iv`];
  const tag = linha[`${prefixo}_tag`];
  if (ciphertext == null || iv == null || tag == null) return null;
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(ciphertext),
      iv: byteaToBuffer(iv),
      tag: byteaToBuffer(tag),
    });
  } catch {
    return null;
  }
}
