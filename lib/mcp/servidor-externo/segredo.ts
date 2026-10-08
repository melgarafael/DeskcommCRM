/**
 * A CHAVE do servidor MCP externo cifrada — o miolo, sem HTTP (#2147, item 3).
 *
 * ── Por que a chave saiu de `organizations.settings` ────────────────────────
 *
 * `settings` é jsonb e a RLS entrega a LINHA da organização a todo membro
 * (`orgs_select`, `fn_user_org_ids` sem filtro de papel): um `viewer` lia
 * `settings.mcp_externo.chave` em claro com a própria sessão. Aqui ela vira
 * coluna cifrada pelo MESMO caminho das chaves de IA — `encryptKey`
 * (`lib/crypto/aes_gcm.ts`), colunas `*_encrypted`/`*_iv`/`*_tag` + `last4` —,
 * e o plaintext só existe no escopo desta chamada. O que a tela mostra é o
 * `last4`; o que sai daqui para log, auditoria ou modelo é `null`.
 *
 * ── O que NÃO faz ──────────────────────────────────────────────────────────
 *
 * Não decide onde gravar (o chamador escolhe a linha, sempre pelo
 * `organization_id` da sessão ou do run) e não trata ausência de
 * `AI_CRED_AES_KEY`: cifra indisponível é problema de instalação e o chamador
 * a transforma em "sem servidor", que é o estado de antes do registro.
 */
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

/**
 * As colunas cifradas no formato que o PostgREST devolve/lê (`\xHEX` para
 * `bytea`). Mesma divisão de `colunasCifradas`, em `lib/ai/credenciais/guardar.ts`.
 */
export interface SegredoCifrado {
  mcp_externo_chave_encrypted: string;
  mcp_externo_chave_iv: string;
  mcp_externo_chave_tag: string;
  mcp_externo_chave_last4: string;
}

/** O que a leitura devolve: as colunas como vieram do banco, ou `null`. */
export type ColunasDoSegredo = Partial<SegredoCifrado> | null | undefined;

/** Plaintext → colunas cifradas. A chave nunca é gravada em claro. */
export function cifrarChaveMcpExterno(chave: string): SegredoCifrado {
  const cifrada = encryptKey(chave);
  return {
    mcp_externo_chave_encrypted: bufToBytea(cifrada.ciphertext),
    mcp_externo_chave_iv: bufToBytea(cifrada.iv),
    mcp_externo_chave_tag: bufToBytea(cifrada.tag),
    mcp_externo_chave_last4: cifrada.last4,
  };
}

/**
 * Colunas → plaintext, ou `null` quando não há chave gravada / a cifra não
 * abre (chave de instalação trocada, coluna corrompida).
 *
 * `null` significa "sem servidor", pelo mesmo contrato de
 * `lerEndpointMcpExterno`: o turno segue com o catálogo compilado, sem rede.
 */
export function abrirChaveMcpExterno(colunas: ColunasDoSegredo): string | null {
  const { mcp_externo_chave_encrypted, mcp_externo_chave_iv, mcp_externo_chave_tag } =
    colunas ?? {};
  if (
    typeof mcp_externo_chave_encrypted !== "string" ||
    typeof mcp_externo_chave_iv !== "string" ||
    typeof mcp_externo_chave_tag !== "string"
  ) {
    return null;
  }
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(mcp_externo_chave_encrypted),
      iv: byteaToBuffer(mcp_externo_chave_iv),
      tag: byteaToBuffer(mcp_externo_chave_tag),
    });
  } catch {
    return null;
  }
}

/**
 * O que substitui as colunas quando o cadastro é apagado (endpoint ou chave em
 * branco apagam, que é o contrato de formulário de sempre).
 *
 * `NULL`, e não string vazia: coluna `bytea` vazia é "chave de verdade, sem
 * bytes", e a leitura leria `""` como segredo presente.
 */
export const SEGREDO_APAGADO = {
  mcp_externo_chave_encrypted: null,
  mcp_externo_chave_iv: null,
  mcp_externo_chave_tag: null,
  mcp_externo_chave_last4: null,
} as const;
