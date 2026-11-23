/**
 * A conexão do chat no site de uma organização, do lado de quem administra (spec 36, F1).
 *
 * O cliente é de service role e ignora a RLS: toda consulta leva `organization_id` À MÃO, e ele
 * vem da sessão de quem administra, nunca do corpo do pedido.
 *
 * A chave pública (`wck_`) não é segredo: está no código-fonte do site do cliente. Ainda assim
 * ela não vai para log nem para audit; a auditoria guarda só o id da conexão.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { configuracaoDoChatSchema, type ConfiguracaoDoChat } from "./config";

export const NOME_DA_CONEXAO_DO_CHAT = "Chat no site";

const COLUNAS =
  "id, display_name, status, webchat_public_key, webchat_allowed_origins, metadata, archived_at";

export interface ConexaoDoChat {
  id: string;
  displayName: string | null;
  status: string | null;
  publicKey: string;
  allowedOrigins: string[];
  config: ConfiguracaoDoChat;
  metadata: Record<string, unknown>;
}

/** `wck_` mais 32 bytes aleatórios em base64url (43 caracteres). */
export function novaChaveDoChat(): string {
  return `wck_${randomBytes(32).toString("base64url")}`;
}

/**
 * A conexão ATIVA do chat na organização, ou `null`. LANÇA quando a consulta falha: "não há
 * conexão" e "não consegui perguntar" levam a desfechos diferentes.
 */
export async function acharConexaoDoChat(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ConexaoDoChat | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", "webchat")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`webchat_session_lookup_failed: ${error.message}`);
  const linha = (data as Record<string, unknown>[] | null)?.[0];
  return linha ? toConexao(linha) : null;
}

function toConexao(linha: Record<string, unknown>): ConexaoDoChat {
  const metadata = (linha.metadata as Record<string, unknown> | null) ?? {};
  // Configuração que não passa no schema vira a padrão, e não derruba a tela de quem administra.
  const lida = configuracaoDoChatSchema.safeParse(metadata.webchat ?? {});
  return {
    id: linha.id as string,
    displayName: (linha.display_name as string) ?? null,
    status: (linha.status as string) ?? null,
    publicKey: linha.webchat_public_key as string,
    allowedOrigins: (linha.webchat_allowed_origins as string[]) ?? [],
    config: lida.success ? lida.data : {},
    metadata,
  };
}
