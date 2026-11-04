/**
 * A carga dos servidores MCP DO AGENTE para um turno — a irmã de
 * `../carregar.ts` (o servidor compartilhado da organização), com o mesmo
 * contrato: rede ANTES do montador síncrono, e falha de terceiro vira ausência,
 * nunca exceção que derrube o turno.
 *
 * ── Quem monta, por modo ─────────────────────────────────────────────────────
 *
 * - `nenhuma` / `chave_estatica`: a regra de sempre. Turno sem contato monta.
 *   Turno COM contato só com `config.mcp_externo_no_atendimento` do agente, e
 *   então com os cabeçalhos `X-Deskcomm-*` resolvidos no banco.
 * - `oauth_por_contato`: SÓ em turno com contato. O token sai do banco por
 *   (organização, servidor, CONTATO DO TURNO), renovado se está para expirar;
 *   os cabeçalhos `X-Deskcomm-*` não vão (a identidade é o token). Sem token
 *   válido, o servidor volta como `sem_autorizacao` e o montador põe no lugar
 *   das ferramentas UMA ferramenta sintética que gera o link de autorização.
 *
 * ── Nenhuma rede sem escolha ─────────────────────────────────────────────────
 *
 * Só carrega servidor que tem pelo menos uma ferramenta escolhida em
 * `tool_ids` (`mcp_externo:<servidor_id>:...`), a mesma porta do item 7 do
 * servidor compartilhado: agente que não escolheu nada não fala com ninguém.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";

import { fetchDeSaida, listarFerramentasDoServidor, type FerramentaRemota } from "../chamada";
import { cabecalhosDoContato } from "../carregar";
import { servidoresEscolhidos } from "../ids";
import { hostDoEndpoint } from "../registro";
import {
  credencialProntaParaOTurno,
  criarPedidoDeAutorizacao,
  marcarUso,
  renovarCredencial,
  type CredencialDoContato,
} from "./credencial";
import { hostsDoServidor } from "./oauth";
import {
  lerServidoresDoAgente,
  semSegredo,
  type ServidorDoAgente,
  type ServidorDoAgenteComSegredo,
} from "./registro";

/** O que o montador recebe de um servidor PRONTO (ferramentas anunciadas). */
export interface ServidorDoAgenteProntoNoTurno {
  estado: "pronto";
  servidor: ServidorDoAgente;
  ferramentas: readonly FerramentaRemota[];
  /** Chamada: endpoint + credencial (chave do cadastro ou token do contato). */
  chamavel: { endpoint: string; chave: string | null };
  cabecalhos?: Readonly<Record<string, string>>;
  /** O contato a que a credencial/identidade está amarrada (turno com contato). */
  contato?: string;
  /** `fetch` de saída (guard anti-SSRF com os hosts do servidor; teste injeta o seu). */
  fetch: FetchLike;
  /**
   * Num 401 com token do contato: renova UMA vez e devolve o token novo, ou
   * `null` (o acesso caiu — o modelo é orientado a pedir de novo).
   */
  renovarAcesso?: () => Promise<string | null>;
  /** Gera o link de step-up (oauth) — mesmo da ferramenta sintética. */
  pedirAcesso?: (escopos?: readonly string[]) => Promise<{ link: string; expiraEm: Date } | null>;
}

/** Um servidor `oauth_por_contato` sem token válido para o contato do turno. */
export interface ServidorDoAgenteSemAutorizacao {
  estado: "sem_autorizacao";
  servidor: ServidorDoAgente;
  contato: string;
  pedirAcesso: (escopos?: readonly string[]) => Promise<{ link: string; expiraEm: Date } | null>;
}

export type ServidorDoAgenteNoTurno = ServidorDoAgenteProntoNoTurno | ServidorDoAgenteSemAutorizacao;

export interface OpcoesDaCargaDoAgente {
  contatoDoTurno?: string;
  conversaDoTurno?: string;
  /** `ai_agents.config.mcp_externo_no_atendimento` — vale para `nenhuma`/`chave_estatica`. */
  noAtendimento?: boolean;
  /** JUNTA DE TESTE: substitui o guard anti-SSRF em toda saída. */
  fetch?: FetchLike;
}

function ehRecusaDeAutenticacao(err: unknown): boolean {
  const codigo = (err as { code?: unknown } | null)?.code;
  return codigo === 401 || (err instanceof Error && /\b401\b/.test(err.message));
}

/**
 * Guarda o que um turno com token viu o servidor anunciar — só nome, descrição
 * e `readOnlyHint` — para o editor do agente oferecer a escolha. Fire-and-forget.
 */
function lembrarFerramentasVistas(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  ferramentas: readonly FerramentaRemota[],
): void {
  if (!servidor.oauth) return;
  const vistas = ferramentas.slice(0, 200).map((f) => ({
    name: f.name,
    ...(f.description ? { description: f.description.slice(0, 500) } : {}),
    ...(f.somenteLeitura ? { somenteLeitura: true } : {}),
  }));
  const antes = JSON.stringify(servidor.oauth.ferramentas_vistas ?? []);
  if (antes === JSON.stringify(vistas)) return;
  void supabase
    .from("ai_agent_mcp_servers")
    .update({ oauth_metadados: { ...servidor.oauth, ferramentas_vistas: vistas } })
    .eq("organization_id", servidor.organizationId)
    .eq("id", servidor.id)
    .then(({ error }) => {
      if (error) logger.warn("nao foi possivel guardar as ferramentas vistas do servidor MCP", { error: error.message });
    });
}

async function carregarOauth(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  contato: string,
  opcoes: OpcoesDaCargaDoAgente,
): Promise<ServidorDoAgenteNoTurno | null> {
  const fetch = opcoes.fetch ?? fetchDeSaida(hostsDoServidor(servidor.endpoint, servidor.oauth));
  const rede = opcoes.fetch ? { fetch: opcoes.fetch } : {};
  const pedirAcesso = (escopos?: readonly string[]) =>
    criarPedidoDeAutorizacao(supabase, {
      servidor,
      contactId: contato,
      ...(opcoes.conversaDoTurno ? { conversationId: opcoes.conversaDoTurno } : {}),
      ...(escopos ? { escopos } : {}),
    });
  const semAutorizacao: ServidorDoAgenteSemAutorizacao = {
    estado: "sem_autorizacao",
    servidor: semSegredo(servidor),
    contato,
    pedirAcesso,
  };
  if (!servidor.oauth || !servidor.oauthClientId) return null;

  let credencial: CredencialDoContato | null = await credencialProntaParaOTurno(supabase, servidor, contato, rede);
  if (!credencial) return semAutorizacao;

  const listar = (token: string) =>
    listarFerramentasDoServidor({ endpoint: servidor.endpoint, chave: token }, { fetch });

  let ferramentas: FerramentaRemota[];
  try {
    ferramentas = await listar(credencial.accessToken);
  } catch (err) {
    if (!ehRecusaDeAutenticacao(err)) {
      logger.warn("servidor MCP do agente nao respondeu — turno segue sem ele", {
        organization_id: servidor.organizationId,
        servidor_id: servidor.id,
        endpoint: hostDoEndpoint(servidor.endpoint),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    // 401 com token: renova uma vez e repete; falhou de novo = sem token.
    credencial = await renovarCredencial(supabase, servidor, contato, credencial, rede);
    if (!credencial) return semAutorizacao;
    try {
      ferramentas = await listar(credencial.accessToken);
    } catch {
      return semAutorizacao;
    }
  }

  void marcarUso(supabase, servidor.organizationId, credencial.id);
  lembrarFerramentasVistas(supabase, servidor, ferramentas);

  let atual = credencial;
  const pronto: ServidorDoAgenteProntoNoTurno = {
    estado: "pronto",
    servidor: semSegredo(servidor),
    ferramentas,
    chamavel: { endpoint: servidor.endpoint, chave: atual.accessToken },
    contato,
    fetch,
    pedirAcesso,
    renovarAcesso: async () => {
      const nova = await renovarCredencial(supabase, servidor, contato, atual, rede);
      if (!nova) return null;
      atual = nova;
      pronto.chamavel = { endpoint: servidor.endpoint, chave: nova.accessToken };
      return nova.accessToken;
    },
  };
  return pronto;
}

async function carregarComChave(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  opcoes: OpcoesDaCargaDoAgente,
): Promise<ServidorDoAgenteNoTurno | null> {
  if (servidor.modo === "chave_estatica" && !servidor.chave) return null;
  const contato = opcoes.contatoDoTurno;
  // A regra do servidor compartilhado: turno com contato só com a opção do
  // agente, e então com a identidade do contato resolvida no banco.
  if (contato && opcoes.noAtendimento !== true) return null;
  const cabecalhos = contato
    ? await cabecalhosDoContato(supabase, servidor.organizationId, contato, opcoes.conversaDoTurno)
    : undefined;
  if (cabecalhos === null) return null;
  const fetch = opcoes.fetch ?? fetchDeSaida(servidor.endpoint);
  const chave = servidor.modo === "chave_estatica" ? servidor.chave : null;
  try {
    const ferramentas = await listarFerramentasDoServidor(
      { endpoint: servidor.endpoint, chave },
      { fetch, ...(cabecalhos ? { cabecalhos } : {}) },
    );
    if (ferramentas.length === 0) return null;
    return {
      estado: "pronto",
      servidor: semSegredo(servidor),
      ferramentas,
      chamavel: { endpoint: servidor.endpoint, chave },
      fetch,
      ...(contato && cabecalhos ? { contato, cabecalhos } : {}),
    };
  } catch (err) {
    logger.warn("servidor MCP do agente nao respondeu — turno segue sem ele", {
      organization_id: servidor.organizationId,
      servidor_id: servidor.id,
      endpoint: hostDoEndpoint(servidor.endpoint),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Os servidores do agente para ESTE turno. `[]` sem rede quando o agente não
 * escolheu ferramenta de nenhum servidor dele, e `[]` quando o módulo opcional
 * `mcp_por_agente` está desligado (doc 252): o que já foi cadastrado fica
 * guardado e para de valer — a mesma porta para os dois runtimes.
 *
 * ponytail: leitura sem memo — só chega aqui o agente que escolheu ferramenta
 * de servidor dele, e desligar vale no turno seguinte. Memo
 * (`moduloLigadoComMemo`) se isto aparecer medido num perfil.
 */
export async function carregarServidoresDoAgenteNoTurno(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string,
  toolIds: readonly string[],
  opcoes: OpcoesDaCargaDoAgente = {},
): Promise<ServidorDoAgenteNoTurno[]> {
  const escolhidos = servidoresEscolhidos(toolIds);
  if (escolhidos.size === 0) return [];
  if (!(await moduloLigado(supabase, "mcp_por_agente"))) return [];
  const servidores = (await lerServidoresDoAgente(supabase, organizationId, agentId, { somenteAtivos: true })).filter(
    (s) => escolhidos.has(s.id),
  );
  const cargas = await Promise.all(
    servidores.map(async (servidor) => {
      try {
        if (servidor.modo === "oauth_por_contato") {
          // Turno sem contato (operador, automação): não há de QUEM ser o acesso.
          return opcoes.contatoDoTurno ? await carregarOauth(supabase, servidor, opcoes.contatoDoTurno, opcoes) : null;
        }
        return await carregarComChave(supabase, servidor, opcoes);
      } catch (err) {
        logger.warn("carga do servidor MCP do agente falhou — turno segue sem ele", {
          organization_id: organizationId,
          servidor_id: servidor.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );
  return cargas.filter((c): c is ServidorDoAgenteNoTurno => c !== null);
}
