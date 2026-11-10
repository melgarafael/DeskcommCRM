/**
 * Pedidos de autorização e credenciais OAuth POR CONTATO — o armazenamento
 * (`mcp_oauth_pedidos`, `contato_mcp_credenciais`, migration 9095).
 *
 * ── As regras que este arquivo guarda ────────────────────────────────────────
 *
 * 1. O token de um contato só é lido por (`organization_id`, `servidor_id`,
 *    `contact_id`) — os três de fonte confiável (run do turno, `state` gravado
 *    no banco). Não existe função aqui que receba token de fora.
 * 2. O `state` é de USO ÚNICO: `consumirPedido` marca `usado_em` num UPDATE
 *    condicional (`usado_em is null and expira_em > now()`) ANTES da troca do
 *    code. Dois callbacks com o mesmo `state` — só um ganha a linha.
 * 3. A renovação concorrente não corrompe: grava com `versao = <lida>` e, se
 *    perdeu a corrida, relê a credencial vencedora em vez de sobrescrevê-la.
 * 4. `invalid_grant` na renovação apaga a credencial: o contato volta ao estado
 *    "sem token", que monta `solicitar_acesso_*`.
 * 5. Token não sai daqui para log, auditoria, erro nem `event_log`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { abrir, apagado, cifrar } from "../cifra";
import {
  ErroDeOauth,
  type ClienteOauth,
  type OpcoesDeRede,
  type TokensDoContato,
  gerarCodeVerifier,
  montarUrlDeAutorizacao,
  novoState,
  renovar,
  revogar,
} from "./oauth";
import { urlDeInicioMcp, urlDoCallbackMcp } from "./enderecos";
import type { ServidorDoAgenteComSegredo } from "./registro";

/** Validade do link de autorização. */
export const VALIDADE_DO_PEDIDO_MS = 10 * 60 * 1000;
/** Renova antes de chamar quando faltam menos que isto para expirar. */
export const MARGEM_DE_RENOVACAO_MS = 60 * 1000;

// ─── Pedido de autorização ───────────────────────────────────────────────────

/**
 * Os escopos de um pedido: os do cadastro, ou o step-up pedido pelo servidor —
 * sempre LIMITADOS aos `escopos_pedidos` (o terceiro não amplia o que o admin
 * decidiu pedir). Pedido vazio vale como "os do cadastro".
 */
export function escoposDoPedido(cadastro: readonly string[], pedidos?: readonly string[]): string[] {
  if (!pedidos || pedidos.length === 0) return [...cadastro];
  if (cadastro.length === 0) return [];
  const permitidos = new Set(cadastro);
  const dentro = pedidos.filter((e) => permitidos.has(e));
  return dentro.length > 0 ? [...new Set(dentro)] : [...cadastro];
}

/**
 * Cria o pedido de uso único e devolve o LINK CURTO. O contato e a conversa
 * vêm do turno (quem chama é o runtime, nunca o modelo).
 */
export async function criarPedidoDeAutorizacao(
  supabase: SupabaseClient,
  entrada: {
    servidor: ServidorDoAgenteComSegredo;
    contactId: string;
    conversationId?: string;
    escopos?: readonly string[];
  },
): Promise<{ link: string; expiraEm: Date } | null> {
  const state = novoState();
  const expiraEm = new Date(Date.now() + VALIDADE_DO_PEDIDO_MS);
  const { error } = await supabase.from("mcp_oauth_pedidos").insert({
    id: state,
    organization_id: entrada.servidor.organizationId,
    servidor_id: entrada.servidor.id,
    contact_id: entrada.contactId,
    conversation_id: entrada.conversationId ?? null,
    ...cifrar("code_verifier", gerarCodeVerifier()),
    escopos: escoposDoPedido(entrada.servidor.escoposPedidos, entrada.escopos),
    expira_em: expiraEm.toISOString(),
  });
  if (error) {
    logger.warn("nao foi possivel criar o pedido de autorizacao MCP", {
      organization_id: entrada.servidor.organizationId,
      servidor_id: entrada.servidor.id,
      error: error.message,
    });
    return null;
  }
  return { link: urlDeInicioMcp(state), expiraEm };
}

export interface PedidoLido {
  id: string;
  organizationId: string;
  servidorId: string;
  contactId: string;
  conversationId: string | null;
  codeVerifier: string;
  escopos: string[];
}

function lerPedido(linha: Record<string, unknown>): PedidoLido | null {
  const codeVerifier = abrir("code_verifier", linha);
  if (!codeVerifier || typeof linha.id !== "string") return null;
  return {
    id: linha.id,
    organizationId: String(linha.organization_id),
    servidorId: String(linha.servidor_id),
    contactId: String(linha.contact_id),
    conversationId: typeof linha.conversation_id === "string" ? linha.conversation_id : null,
    codeVerifier,
    escopos: Array.isArray(linha.escopos) ? (linha.escopos as string[]) : [],
  };
}

const COLUNAS_DO_PEDIDO =
  "id, organization_id, servidor_id, contact_id, conversation_id, code_verifier_encrypted, code_verifier_iv, code_verifier_tag, escopos";

const STATE_VALIDO = /^[A-Za-z0-9_-]{43}$/;

/** O pedido ainda utilizável (não usado, não expirado), sem consumi-lo. */
export async function pedidoValido(supabase: SupabaseClient, state: string): Promise<PedidoLido | null> {
  if (!STATE_VALIDO.test(state)) return null;
  const { data, error } = await supabase
    .from("mcp_oauth_pedidos")
    .select(COLUNAS_DO_PEDIDO)
    .eq("id", state)
    .is("usado_em", null)
    .gt("expira_em", new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  return lerPedido(data as Record<string, unknown>);
}

/**
 * CONSOME o pedido — marca `usado_em` num UPDATE condicional e devolve a linha
 * só para quem ganhou. Reuso, expirado ou inexistente: `null`.
 */
export async function consumirPedido(supabase: SupabaseClient, state: string): Promise<PedidoLido | null> {
  if (!STATE_VALIDO.test(state)) return null;
  const agora = new Date().toISOString();
  const { data, error } = await supabase
    .from("mcp_oauth_pedidos")
    .update({ usado_em: agora })
    .eq("id", state)
    .is("usado_em", null)
    .gt("expira_em", agora)
    .select(COLUNAS_DO_PEDIDO)
    .maybeSingle();
  if (error || !data) return null;
  return lerPedido(data as Record<string, unknown>);
}

/** URL do authorization server para o pedido — o destino do 302 do link curto. */
export function urlDeAutorizacaoDoPedido(servidor: ServidorDoAgenteComSegredo, pedido: PedidoLido): string | null {
  if (!servidor.oauth || !servidor.oauthClientId) return null;
  return montarUrlDeAutorizacao({
    authorizationEndpoint: servidor.oauth.authorization_endpoint,
    clientId: servidor.oauthClientId,
    redirectUri: urlDoCallbackMcp(servidor.id),
    state: pedido.id,
    codeVerifier: pedido.codeVerifier,
    escopos: pedido.escopos,
    recurso: servidor.oauth.recurso,
  });
}

/** O cliente OAuth do servidor, para troca, renovação e revogação. */
export function clienteDoServidor(servidor: ServidorDoAgenteComSegredo): ClienteOauth | null {
  if (!servidor.oauth || !servidor.oauthClientId) return null;
  return {
    tokenEndpoint: servidor.oauth.token_endpoint,
    clientId: servidor.oauthClientId,
    // Cliente do registro dinâmico é PÚBLICO (`token_endpoint_auth_method: none`):
    // um segredo gravado ali só pode ser lixo — medido na VPS, a senha do CRM
    // autopreenchida pelo navegador —, e mandá-lo troca o `client_id` do corpo
    // por Basic, que o AS recusa com invalid_grant.
    clientSecret: servidor.oauth.cliente_dinamico ? null : servidor.oauthClientSecret,
    ...(servidor.oauth.metodos_no_token ? { metodos: servidor.oauth.metodos_no_token } : {}),
    recurso: servidor.oauth.recurso,
  };
}

// ─── Credencial ──────────────────────────────────────────────────────────────

export interface CredencialDoContato {
  id: string;
  versao: number;
  accessToken: string;
  refreshToken: string | null;
  expiraEm: Date | null;
  escopos: string[];
}

const COLUNAS_DA_CREDENCIAL =
  "id, versao, access_token_encrypted, access_token_iv, access_token_tag, refresh_token_encrypted, refresh_token_iv, refresh_token_tag, expira_em, escopos, revogado_em, revogar_apos";

function colunasDosTokens(tokens: TokensDoContato) {
  return {
    ...cifrar("access_token", tokens.accessToken),
    ...(tokens.refreshToken ? cifrar("refresh_token", tokens.refreshToken) : apagado("refresh_token")),
    expira_em: tokens.expiraEm ? tokens.expiraEm.toISOString() : null,
    escopos: tokens.escopos,
  };
}

/**
 * A credencial VIVA do contato para o servidor, ou `null`. Revogada, com
 * revogação vencida ou com cifra que não abre = sem credencial.
 */
export async function credencialDoContato(
  supabase: SupabaseClient,
  organizationId: string,
  servidorId: string,
  contactId: string,
): Promise<CredencialDoContato | null> {
  const { data, error } = await supabase
    .from("contato_mcp_credenciais")
    .select(COLUNAS_DA_CREDENCIAL)
    .eq("organization_id", organizationId)
    .eq("servidor_id", servidorId)
    .eq("contact_id", contactId)
    .is("revogado_em", null)
    .maybeSingle();
  if (error || !data) return null;
  const linha = data as Record<string, unknown>;
  if (typeof linha.revogar_apos === "string" && new Date(linha.revogar_apos).getTime() <= Date.now()) {
    return null;
  }
  const accessToken = abrir("access_token", linha);
  if (!accessToken) return null;
  return {
    id: String(linha.id),
    versao: Number(linha.versao),
    accessToken,
    refreshToken: abrir("refresh_token", linha),
    expiraEm: typeof linha.expira_em === "string" ? new Date(linha.expira_em) : null,
    escopos: Array.isArray(linha.escopos) ? (linha.escopos as string[]) : [],
  };
}

/**
 * Grava a credencial nova do (servidor, contato). Se havia uma viva, ela é
 * REVOGADA no terceiro antes (uma autorização nova substitui a anterior).
 * `revogarApos`: a revogação já agendada no nascimento (conversa encerrada).
 */
export async function gravarCredencial(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  contactId: string,
  tokens: TokensDoContato,
  opcoes?: OpcoesDeRede & { revogarApos?: Date | null },
): Promise<boolean> {
  const anterior = await credencialDoContato(supabase, servidor.organizationId, servidor.id, contactId);
  if (anterior) await revogarNoTerceiro(servidor, anterior, opcoes);
  const { error } = await supabase.from("contato_mcp_credenciais").upsert(
    {
      organization_id: servidor.organizationId,
      servidor_id: servidor.id,
      contact_id: contactId,
      ...colunasDosTokens(tokens),
      // Versão NOVA, nunca `1`: uma renovação que leu a credencial ANTERIOR
      // (versão 1, digamos) não pode casar o `where versao = 1` e sobrescrever
      // a autorização nova com o token derivado da antiga.
      versao: Math.floor(Date.now() / 1000),
      revogado_em: null,
      revogar_apos: opcoes?.revogarApos ? opcoes.revogarApos.toISOString() : null,
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: "servidor_id,contact_id" },
  );
  if (error) {
    logger.warn("nao foi possivel gravar a credencial MCP do contato", {
      organization_id: servidor.organizationId,
      servidor_id: servidor.id,
      error: error.message,
    });
    return false;
  }
  return true;
}

/** Apaga a credencial (sem revogar no terceiro) — `invalid_grant`, LGPD. */
export async function apagarCredencial(
  supabase: SupabaseClient,
  organizationId: string,
  credencialId: string,
): Promise<void> {
  await supabase.from("contato_mcp_credenciais").delete().eq("organization_id", organizationId).eq("id", credencialId);
}

/** Espera antes de reler quando outro turno está renovando a mesma credencial. */
const ESPERA_DA_RENOVACAO_ALHEIA_MS = 400;

/**
 * Renova com TRAVA LEVE, em duas gravações condicionais:
 *
 * 1. REIVINDICA: `versao = v+1 where versao = v`. Só um turno ganha; os outros
 *    não chamam o authorization server (com rotação de refresh token, a
 *    segunda chamada receberia `invalid_grant` e mataria a credencial).
 * 2. Quem ganhou chama o AS e grava os tokens com `versao = v+2 where versao = v+1`.
 *
 * Perdeu a reivindicação: espera um instante e relê — devolve a credencial que
 * o vencedor gravou. `invalid_grant` (para quem ganhou): apaga a credencial e
 * devolve `null` (o contato volta a "sem token"). Rede/recusa: `null`, tokens
 * intactos (a próxima tentativa decide).
 */
export async function renovarCredencial(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  contactId: string,
  credencial: CredencialDoContato,
  opcoes?: OpcoesDeRede,
): Promise<CredencialDoContato | null> {
  const cliente = clienteDoServidor(servidor);
  if (!cliente || !credencial.refreshToken) return null;

  const reivindicada = credencial.versao + 1;
  const { data: claim, error: erroDoClaim } = await supabase
    .from("contato_mcp_credenciais")
    .update({ versao: reivindicada, atualizado_em: new Date().toISOString() })
    .eq("organization_id", servidor.organizationId)
    .eq("id", credencial.id)
    .eq("versao", credencial.versao)
    .select("id")
    .maybeSingle();
  if (erroDoClaim) return null;
  if (!claim) {
    await new Promise((ok) => setTimeout(ok, ESPERA_DA_RENOVACAO_ALHEIA_MS));
    const relida = await credencialDoContato(supabase, servidor.organizationId, servidor.id, contactId);
    return relida && relida.accessToken !== credencial.accessToken ? relida : null;
  }

  let novos: TokensDoContato;
  try {
    novos = await renovar(cliente, credencial.refreshToken, credencial.escopos, opcoes);
  } catch (err) {
    if (err instanceof ErroDeOauth && err.codigo === "invalid_grant") {
      await supabase
        .from("contato_mcp_credenciais")
        .delete()
        .eq("organization_id", servidor.organizationId)
        .eq("id", credencial.id)
        .eq("versao", reivindicada);
      logger.info("refresh recusado com invalid_grant — credencial MCP do contato apagada", {
        organization_id: servidor.organizationId,
        servidor_id: servidor.id,
      });
    }
    return null;
  }
  const versaoNova = reivindicada + 1;
  const { data, error } = await supabase
    .from("contato_mcp_credenciais")
    .update({ ...colunasDosTokens(novos), versao: versaoNova, atualizado_em: new Date().toISOString() })
    .eq("organization_id", servidor.organizationId)
    .eq("id", credencial.id)
    .eq("versao", reivindicada)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    // Uma autorização nova substituiu a linha no meio do caminho: ela vence.
    return credencialDoContato(supabase, servidor.organizationId, servidor.id, contactId);
  }
  return {
    id: credencial.id,
    versao: versaoNova,
    accessToken: novos.accessToken,
    refreshToken: novos.refreshToken,
    expiraEm: novos.expiraEm,
    escopos: novos.escopos,
  };
}

/** Precisa renovar antes de usar? */
export function expiraLogo(c: CredencialDoContato, agora: number = Date.now()): boolean {
  return c.expiraEm !== null && c.expiraEm.getTime() - agora < MARGEM_DE_RENOVACAO_MS;
}

/**
 * O token pronto para o turno: lido do banco PELO CONTATO DO TURNO e renovado
 * se está para expirar. `null` = sem acesso (monta `solicitar_acesso_*`).
 */
export async function credencialProntaParaOTurno(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  contactId: string,
  opcoes?: OpcoesDeRede,
): Promise<CredencialDoContato | null> {
  const lida = await credencialDoContato(supabase, servidor.organizationId, servidor.id, contactId);
  if (!lida) return null;
  if (!expiraLogo(lida)) return lida;
  return renovarCredencial(supabase, servidor, contactId, lida, opcoes);
}

export async function marcarUso(supabase: SupabaseClient, organizationId: string, credencialId: string): Promise<void> {
  await supabase
    .from("contato_mcp_credenciais")
    .update({ ultimo_uso_em: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", credencialId);
}

// ─── Revogação ───────────────────────────────────────────────────────────────

/** RFC 7009 no terceiro, melhor esforço: refresh primeiro (derruba a família), depois o access. */
export async function revogarNoTerceiro(
  servidor: ServidorDoAgenteComSegredo,
  credencial: Pick<CredencialDoContato, "accessToken" | "refreshToken">,
  opcoes?: OpcoesDeRede,
): Promise<boolean> {
  const revocationEndpoint = servidor.oauth?.revocation_endpoint;
  const cliente = clienteDoServidor(servidor);
  if (!revocationEndpoint || !cliente) return false;
  const alvo = { clientId: cliente.clientId, clientSecret: cliente.clientSecret ?? null, recurso: cliente.recurso, revocationEndpoint };
  let ok = true;
  if (credencial.refreshToken) ok = (await revogar(alvo, credencial.refreshToken, "refresh_token", opcoes)) && ok;
  ok = (await revogar(alvo, credencial.accessToken, "access_token", opcoes)) && ok;
  return ok;
}

/**
 * Revoga (terceiro + banco) uma credencial VIVA lida pelo id, dentro da
 * organização. `apagar` remove a linha inteira (LGPD, servidor removido); sem
 * ele a linha fica com os tokens em `NULL` e `revogado_em` marcado.
 *
 * A linha é RECLAMADA antes da rede: um UPDATE condicional (`revogado_em is
 * null and versao = <lida>`) esvazia os tokens e marca `revogado_em`, e só quem
 * ganhou fala com o terceiro, com os tokens que leu. Duas rodadas do cron (ou
 * o cron e o botão da ficha) sobre a mesma linha: uma revoga e audita, a outra
 * recebe `null`. A versão sobe junto, então uma renovação em curso não grava
 * token novo por cima da linha revogada.
 */
export async function revogarCredencialPorId(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  credencialId: string,
  opcoes?: OpcoesDeRede & { apagar?: boolean },
): Promise<{ revogadaNoTerceiro: boolean } | null> {
  const { data, error } = await supabase
    .from("contato_mcp_credenciais")
    .select(COLUNAS_DA_CREDENCIAL)
    .eq("organization_id", servidor.organizationId)
    .eq("servidor_id", servidor.id)
    .eq("id", credencialId)
    .is("revogado_em", null)
    .maybeSingle();
  if (error || !data) return null;
  const linha = data as Record<string, unknown>;
  const versao = Number(linha.versao);
  const agora = new Date().toISOString();
  const { data: ganhou, error: erroDoClaim } = await supabase
    .from("contato_mcp_credenciais")
    .update({
      ...apagado("access_token"),
      ...apagado("refresh_token"),
      versao: versao + 1,
      revogado_em: agora,
      atualizado_em: agora,
    })
    .eq("organization_id", servidor.organizationId)
    .eq("id", credencialId)
    .is("revogado_em", null)
    .eq("versao", versao)
    .select("id")
    .maybeSingle();
  if (erroDoClaim || !ganhou) return null;

  const accessToken = abrir("access_token", linha);
  const revogadaNoTerceiro = accessToken
    ? await revogarNoTerceiro(servidor, { accessToken, refreshToken: abrir("refresh_token", linha) }, opcoes)
    : false;
  if (opcoes?.apagar) await apagarCredencial(supabase, servidor.organizationId, credencialId);
  return { revogadaNoTerceiro };
}

/** O que a ficha do contato mostra: nunca o token. */
export interface AcessoDoContato {
  id: string;
  servidorId: string;
  servidorNome: string;
  agenteId: string;
  escopos: string[];
  desde: string;
  ultimoUso: string | null;
  revogarApos: string | null;
}

export async function listarAcessosDoContato(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<AcessoDoContato[]> {
  const { data, error } = await supabase
    .from("contato_mcp_credenciais")
    .select("id, servidor_id, escopos, criado_em, ultimo_uso_em, revogar_apos, ai_agent_mcp_servers(nome, agent_id)")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .is("revogado_em", null)
    .order("criado_em", { ascending: false });
  if (error) return [];
  return ((data ?? []) as Record<string, unknown>[]).map((l) => {
    const s = (l.ai_agent_mcp_servers ?? {}) as { nome?: string; agent_id?: string };
    return {
      id: String(l.id),
      servidorId: String(l.servidor_id),
      servidorNome: s.nome ?? "",
      agenteId: s.agent_id ?? "",
      escopos: Array.isArray(l.escopos) ? (l.escopos as string[]) : [],
      desde: String(l.criado_em),
      ultimoUso: typeof l.ultimo_uso_em === "string" ? l.ultimo_uso_em : null,
      revogarApos: typeof l.revogar_apos === "string" ? l.revogar_apos : null,
    };
  });
}
