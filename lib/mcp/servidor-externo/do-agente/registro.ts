/**
 * Os servidores MCP externos DE UM AGENTE (`ai_agent_mcp_servers`, migration
 * 9095) — o cadastro, a validação e a leitura que o turno e a tela fazem.
 *
 * ── Ao lado do servidor da organização, não no lugar dele ───────────────────
 *
 * O servidor de `organizations.settings.mcp_externo` (`../registro.ts`) segue
 * como o servidor COMPARTILHADO, disponível a todo agente, com os mesmos ids
 * de sempre (`mcp_externo:<marca>:<nome>`). Os do agente têm o id do servidor
 * no prefixo (`mcp_externo:<servidor_id>:<marca>:<nome>`) — escolha (b) do
 * documento da feature: nenhuma instalação precisa migrar dado para continuar
 * funcionando, e nenhum teste do servidor compartilhado muda de significado.
 *
 * ── A tabela é server-side only ─────────────────────────────────────────────
 *
 * Toda leitura daqui usa o service role e filtra `organization_id` E `agent_id`
 * à mão, com valores de fonte confiável (run, sessão). O segredo nunca sai
 * deste módulo aberto: `lerServidoresDoAgente` devolve a chave/`client_secret`
 * apenas para o chamador de servidor que pediu, e `paraATela` remove tudo que
 * não seja `last4`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { logger } from "@/lib/logger";

import { abrir } from "../cifra";

/** Teto de servidores por agente — cada um é rede no caminho quente do turno. */
export const LIMITE_DE_SERVIDORES_POR_AGENTE = 5;

export const MODOS_DE_AUTENTICACAO = ["nenhuma", "chave_estatica", "oauth_por_contato"] as const;
export type ModoDeAutenticacao = (typeof MODOS_DE_AUTENTICACAO)[number];

/** O cache da descoberta (RFC 9728 + RFC 8414) e do registro dinâmico (RFC 7591). */
export const MetadadosOauthSchema = z.object({
  /** O `resource` (RFC 8707) — o identificador do servidor MCP no authorization server. */
  recurso: z.url(),
  emissor: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  registration_endpoint: z.url().optional(),
  revocation_endpoint: z.url().optional(),
  escopos_suportados: z.array(z.string()).default([]),
  /** O `client_id` veio do registro dinâmico (e não da tela)? */
  cliente_dinamico: z.boolean().default(false),
  /**
   * `token_endpoint_auth_methods_supported` do AS. `["none"]` = só cliente
   * público: o Deskcomm nunca manda segredo, mesmo que haja um gravado.
   */
  metodos_no_token: z.array(z.string()).optional(),
  /** Para quem lê na tela: quando a descoberta foi feita. */
  descoberto_em: z.string(),
  /**
   * O que um turno com token de contato já viu o servidor anunciar (só nome,
   * descrição e `readOnlyHint` — nunca dado). É o que deixa o admin escolher
   * ferramentas de um servidor que não lista nada sem token.
   */
  ferramentas_vistas: z
    .array(z.object({ name: z.string(), description: z.string().optional(), somenteLeitura: z.boolean().optional() }))
    .max(200)
    .optional(),
});
export type MetadadosOauth = z.infer<typeof MetadadosOauthSchema>;

/** O servidor como o runtime e a tela o entendem (sem segredo). */
export interface ServidorDoAgente {
  id: string;
  organizationId: string;
  agentId: string;
  nome: string;
  slug: string;
  endpoint: string;
  modo: ModoDeAutenticacao;
  chaveLast4: string | null;
  oauthClientId: string | null;
  temClientSecret: boolean;
  oauth: MetadadosOauth | null;
  escoposPedidos: string[];
  escritaDelegada: boolean;
  retencaoHoras: number;
  ativo: boolean;
}

/** O mesmo servidor com os segredos abertos — só para quem vai falar com ele. */
export interface ServidorDoAgenteComSegredo extends ServidorDoAgente {
  chave: string | null;
  oauthClientSecret: string | null;
}

export const COLUNAS_DO_SERVIDOR =
  "id, organization_id, agent_id, nome, slug, endpoint, modo_autenticacao, chave_encrypted, chave_iv, chave_tag, chave_last4, oauth_client_id, oauth_client_secret_encrypted, oauth_client_secret_iv, oauth_client_secret_tag, oauth_metadados, escopos_pedidos, escrita_delegada, retencao_apos_encerramento_horas, ativo";

/** Linha crua → servidor. `null` quando a linha não tem a forma esperada. */
export function lerLinhaDoServidor(linha: Record<string, unknown>): ServidorDoAgenteComSegredo | null {
  const modo = linha.modo_autenticacao;
  if (typeof linha.id !== "string" || !MODOS_DE_AUTENTICACAO.includes(modo as ModoDeAutenticacao)) {
    return null;
  }
  const oauth = MetadadosOauthSchema.safeParse(linha.oauth_metadados);
  return {
    id: linha.id,
    organizationId: String(linha.organization_id),
    agentId: String(linha.agent_id),
    nome: String(linha.nome),
    slug: String(linha.slug),
    endpoint: String(linha.endpoint),
    modo: modo as ModoDeAutenticacao,
    chaveLast4: typeof linha.chave_last4 === "string" ? linha.chave_last4 : null,
    oauthClientId: typeof linha.oauth_client_id === "string" ? linha.oauth_client_id : null,
    temClientSecret: linha.oauth_client_secret_encrypted != null,
    oauth: oauth.success ? oauth.data : null,
    escoposPedidos: Array.isArray(linha.escopos_pedidos) ? (linha.escopos_pedidos as string[]) : [],
    escritaDelegada: linha.escrita_delegada === true,
    retencaoHoras: typeof linha.retencao_apos_encerramento_horas === "number" ? linha.retencao_apos_encerramento_horas : 0,
    ativo: linha.ativo !== false,
    chave: abrir("chave", linha),
    oauthClientSecret: abrir("oauth_client_secret", linha),
  };
}

/** Tira os segredos — o que pode ir para a tela, para o log e para a auditoria. */
export function semSegredo(s: ServidorDoAgenteComSegredo): ServidorDoAgente {
  const { chave: _chave, oauthClientSecret: _segredo, ...resto } = s;
  return resto;
}

/**
 * Os servidores de UM agente. Nunca lança: erro de leitura é `[]` (o turno
 * segue com o catálogo compilado) com o motivo no log.
 */
export async function lerServidoresDoAgente(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string,
  opcoes?: { somenteAtivos?: boolean },
): Promise<ServidorDoAgenteComSegredo[]> {
  let q = supabase
    .from("ai_agent_mcp_servers")
    .select(COLUNAS_DO_SERVIDOR)
    .eq("organization_id", organizationId)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: true })
    .limit(LIMITE_DE_SERVIDORES_POR_AGENTE);
  if (opcoes?.somenteAtivos) q = q.eq("ativo", true);
  const { data, error } = await q;
  if (error) {
    logger.warn("nao foi possivel ler os servidores MCP do agente", {
      organization_id: organizationId,
      error: error.message,
    });
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[])
    .map(lerLinhaDoServidor)
    .filter((s): s is ServidorDoAgenteComSegredo => s !== null);
}

/** Um servidor pelo id, sempre dentro da organização dada. */
export async function lerServidor(
  supabase: SupabaseClient,
  organizationId: string,
  servidorId: string,
): Promise<ServidorDoAgenteComSegredo | null> {
  const { data, error } = await supabase
    .from("ai_agent_mcp_servers")
    .select(COLUNAS_DO_SERVIDOR)
    .eq("organization_id", organizationId)
    .eq("id", servidorId)
    .maybeSingle();
  if (error || !data) return null;
  return lerLinhaDoServidor(data as Record<string, unknown>);
}

// ─── Nomes ───────────────────────────────────────────────────────────────────

const NOME_DE_PROTOCOLO = /^[A-Za-z0-9_-]{1,64}$/;

/** O slug do servidor a partir do nome de exibição: `Minha Casa` → `minhacasa`. */
export function slugDoNome(nome: string): string {
  const base = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16);
  return base === "" ? "mcp" : base;
}

/**
 * O nome que o MODELO vê: `<slug>__<nome remoto>`, estável e sem colisão entre
 * servidores. `null` quando a concatenação sairia do formato do protocolo — a
 * ferramenta não monta (o log diz qual), em vez de virar nome truncado que
 * poderia colidir com outro.
 */
export function nomeParaOModelo(slug: string, nomeRemoto: string): string | null {
  const nome = `${slug}__${nomeRemoto}`;
  return NOME_DE_PROTOCOLO.test(nome) ? nome : null;
}

/** O nome da ferramenta sintética que pede o acesso do contato. */
export function nomeDaFerramentaDeAcesso(slug: string): string {
  return `solicitar_acesso_${slug}`;
}

// ─── Entrada da tela ─────────────────────────────────────────────────────────

const escopo = z.string().trim().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/, "escopo inválido");

/** O que a action de cadastro recebe. `chave`/`clientSecret` vazios = manter o atual. */
export const EntradaDoServidorSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    endpoint: z.url().max(2048),
    modo: z.enum(MODOS_DE_AUTENTICACAO),
    chave: z.string().trim().max(4096).optional().default(""),
    oauthClientId: z.string().trim().max(512).optional().default(""),
    oauthClientSecret: z.string().trim().max(4096).optional().default(""),
    escoposPedidos: z.array(escopo).max(50).default([]),
    escritaDelegada: z.boolean().default(false),
    retencaoHoras: z.number().int().min(0).max(720).default(0),
    ativo: z.boolean().default(true),
  })
  .strict()
  .refine((e) => !e.escritaDelegada || e.modo === "oauth_por_contato", {
    message: "escrita_delegada_so_com_oauth",
    path: ["escritaDelegada"],
  });
export type EntradaDoServidor = z.infer<typeof EntradaDoServidorSchema>;

/**
 * O endereço é seguro para cadastrar? Mesma régua do servidor da organização:
 * http(s), sem usuário/senha, SEM querystring nem fragmento (segredo no
 * endereço iria parar no audit log append-only), e a prova textual anti-SSRF.
 * Lança `unsafe_url:*`.
 */
export function conferirEndpointDoServidor(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("unsafe_url:invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsafe_url:invalid");
  if (url.username !== "" || url.password !== "") throw new Error("unsafe_url:invalid");
  if (url.search !== "" || url.hash !== "") throw new Error("unsafe_url:invalid");
  assertSafeOutboundUrl(endpoint);
}
