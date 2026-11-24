/**
 * A conexão do chat no site a partir do que o VISITANTE manda (spec 36, F1).
 *
 * `conexaoPelaChave` lê a chave pública (`wck_`) de `sessao`; `conexaoPeloId` lê o id
 * da conexão que vem assinado no token de visitante, em `mensagens`. Nas duas, a
 * organização sai da LINHA da conexão, nunca do pedido.
 *
 * Devolve `null` nos cinco casos que a rota responde com o mesmo 404: chave (ou conexão)
 * inexistente, conexão arquivada, organização que não opera, módulo desligado e chat pausado
 * (`metadata.webchat.pausado`). A rota não distingue um do outro. LANÇA quando a consulta falha: "não existe" e "não consegui
 * perguntar" levam a desfechos diferentes.
 *
 * O cliente é de service role: toda consulta filtra o que importa à mão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehOperante } from "@/lib/organizacao/operante";

import { configuracaoDoChatSchema, type ConfiguracaoDoChat } from "./config";
import { chatNoSiteLigado } from "./modulo";

export interface ConexaoPublica {
  id: string;
  organizationId: string;
  config: ConfiguracaoDoChat;
  /** Domínios que podem embutir a janela (`frame-ancestors`). Lista vazia = ninguém. */
  allowedOrigins: string[];
}

const COLUNAS = "id, organization_id, metadata, webchat_allowed_origins";

/** A conexão ativa de chat no site que a chave pública identifica, ou `null`. */
export async function conexaoPelaChave(admin: SupabaseClient, chave: string): Promise<ConexaoPublica | null> {
  return conexaoPor(admin, "webchat_public_key", chave);
}

/** A conexão ativa de chat no site com este id (a do token de visitante), ou `null`. */
export async function conexaoPeloId(admin: SupabaseClient, id: string): Promise<ConexaoPublica | null> {
  return conexaoPor(admin, "id", id);
}

/**
 * O `Bearer` do cabeçalho `Authorization`, ou `null`. Nunca lê a URL: o token de visitante
 * não vai em query string.
 */
export function tokenDoBearer(headers: Headers): string | null {
  const bruto = headers.get("authorization") ?? "";
  const casou = /^Bearer\s+(\S+)$/i.exec(bruto.trim());
  return casou?.[1] ?? null;
}

async function conexaoPor(
  admin: SupabaseClient,
  coluna: "id" | "webchat_public_key",
  valor: string,
): Promise<ConexaoPublica | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq(coluna, valor)
    .eq("provider", "webchat")
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("webchat_session_lookup_failed");
  const linha = data as Record<string, unknown> | null;
  if (!linha) return null;

  const organizationId = linha.organization_id as string;
  const { data: org, error: erroOrg } = await admin
    .from("organizations")
    .select("status")
    .eq("id", organizationId)
    .maybeSingle();
  if (erroOrg) throw new Error("webchat_org_lookup_failed");
  const status = (org as { status?: string } | null)?.status ?? null;
  if (!ehOperante(status)) return null;

  if (!(await chatNoSiteLigado(admin, organizationId))) return null;

  const metadata = (linha.metadata as Record<string, unknown> | null) ?? {};
  // Configuração que não passa no schema vira a padrão: não derruba a entrada do visitante.
  const lida = configuracaoDoChatSchema.safeParse(metadata.webchat ?? {});
  const config: ConfiguracaoDoChat = lida.success ? lida.data : {};
  // Chat pausado pela organização: para o visitante, é a conexão que não existe. Lê o valor BRUTO,
  // antes do schema: configuração com chave estranha ou valor fora do limite vira `{}` acima, e a
  // pausa não pode se perder junto (falha aberta = chat pausado que continua abrindo).
  const bruto = metadata.webchat as { pausado?: unknown } | null | undefined;
  if (bruto !== null && typeof bruto === "object" && bruto.pausado === true) return null;
  const origens = Array.isArray(linha.webchat_allowed_origins)
    ? linha.webchat_allowed_origins.filter((o): o is string => typeof o === "string")
    : [];
  return {
    id: linha.id as string,
    organizationId,
    config,
    allowedOrigins: origens,
  };
}
