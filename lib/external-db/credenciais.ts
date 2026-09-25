/**
 * A conexão externa — lida do banco e decifrada just-in-time.
 *
 * ⚠️ SEMPRE COM `organization_id` NO FILTRO. É a lição da #236: o admin client
 * bypassa RLS, e uma busca só por `id` casaria linha de outra organização. O
 * índice é `(organization_id, label)`, mas o filtro por org vem do
 * `activeOrg` resolvido no cookie/JWT — nunca do corpo da requisição.
 *
 * A senha só existe no objeto devolvido. Quem chama descarta a referência no
 * fim; ela nunca é logada, persistida em claro ou devolvida por rota.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

import { LIMITE_FILTROS, LIMITE_LINHAS, LIMITE_RESPOSTA_BYTES } from "./limites";
import type { ConexaoExterna, ModoTls } from "./types";

/** Um valor de limite ausente/ inválido cai no padrão — nunca em "sem limite". */
function limiteOuPadrao(valor: number | null, padrao: number): number {
  return typeof valor === "number" && Number.isFinite(valor) && valor >= 0 ? valor : padrao;
}

/**
 * Cifra a senha para gravação. As três colunas seguem `ai_provider_credentials`
 * (AES-256-GCM). O chamador descarta o plaintext logo depois do INSERT/UPDATE;
 * ele nunca é logado nem devolvido.
 */
export function cifrarSenha(senha: string): {
  password_encrypted: string;
  password_iv: string;
  password_tag: string;
} {
  const e = encryptKey(senha);
  return {
    password_encrypted: bufToBytea(e.ciphertext),
    password_iv: bufToBytea(e.iv),
    password_tag: bufToBytea(e.tag),
  };
}

export type MotivoSemConexao =
  | "nao_encontrada"
  | "desativada"
  | "cifra_indisponivel"
  | "banco";

export type LeituraConexao =
  | { ok: true; conexao: ConexaoExterna }
  | { ok: false; motivo: MotivoSemConexao };

interface LinhaConexao {
  id: string;
  organization_id: string;
  label: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password_encrypted: unknown;
  password_iv: unknown;
  password_tag: unknown;
  ssl_mode: ModoTls;
  enabled: boolean;
  max_rows: number | null;
  max_filters: number | null;
  max_response_bytes: number | null;
  updated_at: string;
}

export async function carregarConexao(
  admin: SupabaseClient,
  organizationId: string,
  connectionId: string,
): Promise<LeituraConexao> {
  const { data, error } = await admin
    .from("external_db_connections")
    .select(
      "id, organization_id, label, host, port, database_name, username, password_encrypted, password_iv, password_tag, ssl_mode, enabled, max_rows, max_filters, max_response_bytes, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("id", connectionId)
    .maybeSingle<LinhaConexao>();

  if (error) {
    logger.error("[external-db.credencial] leitura falhou", {
      organizationId,
      connectionId,
      error: error.message,
    });
    return { ok: false, motivo: "banco" };
  }
  if (!data) return { ok: false, motivo: "nao_encontrada" };
  if (!data.enabled) return { ok: false, motivo: "desativada" };

  let password: string;
  try {
    password = decryptKey({
      ciphertext: byteaToBuffer(data.password_encrypted),
      iv: byteaToBuffer(data.password_iv),
      tag: byteaToBuffer(data.password_tag),
    });
  } catch {
    // Não loga o erro do decrypt com detalhe que possa conter material da chave.
    // Cifra indisponível é problema de INSTALAÇÃO (falta AI_CRED_AES_KEY), e a
    // tela precisa distinguir isso de "conexão não existe".
    return { ok: false, motivo: "cifra_indisponivel" };
  }

  return {
    ok: true,
    conexao: {
      id: data.id,
      organizationId: data.organization_id,
      label: data.label,
      host: data.host,
      port: data.port,
      database: data.database_name,
      username: data.username,
      password,
      sslMode: data.ssl_mode,
      maxRows: limiteOuPadrao(data.max_rows, LIMITE_LINHAS.padrao),
      maxFilters: limiteOuPadrao(data.max_filters, LIMITE_FILTROS.padrao),
      maxResponseBytes: limiteOuPadrao(data.max_response_bytes, LIMITE_RESPOSTA_BYTES.padrao),
      versao: data.updated_at,
    },
  };
}
