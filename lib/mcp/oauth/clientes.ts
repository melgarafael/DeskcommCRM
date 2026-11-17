/**
 * Clientes OAuth do MCP: busca e autenticação no token/revogação.
 *
 * O registro é aberto (RFC 7591) — qualquer um registra um cliente. Por isso o
 * cliente NUNCA é autoridade sobre nada: quem dá acesso é a pessoa, na tela de
 * consentimento, que mostra o nome que o cliente declarou E o host para onde o
 * código vai. O `client_id` só amarra o código ao mesmo cliente que o pediu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CLIENT_ID } from "./esquemas";
import { segredoConfere } from "./segredos";

export interface ClienteOAuth {
  id: string;
  client_id: string;
  nome: string;
  redirect_uris: string[];
  metodo_de_autenticacao: "none" | "client_secret_post" | "client_secret_basic";
  client_secret_hash: string | null;
  /** Última troca ou renovação concluída. `null` = o cliente nunca obteve um token aqui. */
  ultimo_uso_em: string | null;
}

const COLUNAS = "id, client_id, nome, redirect_uris, metodo_de_autenticacao, client_secret_hash, ultimo_uso_em";

export async function buscarCliente(admin: SupabaseClient, clientId: string): Promise<ClienteOAuth | null> {
  if (!CLIENT_ID.test(clientId)) return null;
  const { data, error } = await admin
    .from("mcp_oauth_clientes")
    .select(COLUNAS)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ClienteOAuth;
}

/** `Authorization: Basic base64(urlencode(id):urlencode(segredo))` (RFC 6749 §2.3.1). */
export function credenciaisBasic(cabecalho: string | null): { clientId: string; segredo: string } | null {
  if (!cabecalho) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(cabecalho.trim());
  if (!m) return null;
  let decodificado: string;
  try {
    decodificado = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const i = decodificado.indexOf(":");
  if (i < 0) return null;
  try {
    return {
      clientId: decodeURIComponent(decodificado.slice(0, i)),
      segredo: decodeURIComponent(decodificado.slice(i + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * Identifica e autentica o cliente no token/revogação. Cliente público
 * (`none`) só se identifica — a prova é o PKCE (e, no refresh, a posse do
 * refresh token). Cliente com segredo tem de apresentá-lo pelo método que
 * registrou.
 */
export async function autenticarCliente(
  admin: SupabaseClient,
  corpo: { client_id?: string; client_secret?: string },
  authorization: string | null,
): Promise<ClienteOAuth | null> {
  const basic = credenciaisBasic(authorization);
  const clientId = basic?.clientId ?? corpo.client_id;
  if (!clientId) return null;
  if (basic && corpo.client_id && corpo.client_id !== basic.clientId) return null;

  const cliente = await buscarCliente(admin, clientId);
  if (!cliente) return null;

  if (cliente.metodo_de_autenticacao === "none") return cliente;
  const segredo = cliente.metodo_de_autenticacao === "client_secret_basic" ? basic?.segredo : corpo.client_secret ?? basic?.segredo;
  if (!segredo || !segredoConfere(segredo, cliente.client_secret_hash)) return null;
  return cliente;
}
