/**
 * A ponte entre o REGISTRO (jsonb + colunas cifradas) e o TURNO: lê, descobre
 * e devolve pronto para `pickToolsFromMcp` montar (#2147).
 *
 * ── Por que a descoberta mora aqui e não dentro do montador ─────────────────
 *
 * `pickToolsFromMcp` é síncrono — ele compõe tools a partir de definições que
 * já estão na mão. Listar ferramentas é rede. Fazer a rede ANTES, e passar o
 * resultado como dado, é o que mantém o montador puro e o turno dono do
 * orçamento de tempo.
 *
 * ── Por que falha vira `null` e não exceção ─────────────────────────────────
 *
 * O ERP registrado é um sistema alheio: pode estar desligado, atrás de
 * firewall, com a chave trocada. Nada disso é defeito do turno — sem as
 * ferramentas remotas o agente continua com o catálogo compilado, que é o
 * estado de antes do registro. Lançar aqui derrubaria a virada de turno inteira
 * por causa de um terceiro fora do ar, e é o registro que o operador pode
 * desligar, não o agente.
 *
 * ── TURNO COM CONTATO: só com a opção do agente, e com a identidade forçada ─
 *
 * Sem identificação, uma leitura remota durante a conversa poderia devolver
 * dado de OUTRO cliente ao modelo — e do modelo ao contato. Por isso o turno
 * com contato só carrega o servidor quando o agente tem
 * `config.mcp_externo_no_atendimento` ligado (desligado de fábrica; desligado,
 * o turno é exatamente o de antes da opção: `null`, sem banco e sem rede).
 *
 * Ligada, a carga resolve o contato NO BANCO (id + organização do turno) e
 * amarra ao servidor montado os cabeçalhos `X-Deskcomm-*`
 * (`CABECALHOS_DO_CONTATO`), que vão em toda requisição — listar e chamar. O
 * valor nunca vem de argumento de ferramenta. Contato que não resolve (erro,
 * outra organização) = `null`: falha fechada na ação. Cobre o Conversador e o
 * Operador, que os dois montam ferramentas passando o contato do turno.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { logger } from "@/lib/logger";
import {
  CABECALHOS_DO_CONTATO,
  listarFerramentasDoServidor,
  type FerramentaRemota,
} from "./chamada";
import { escolhasRemotas } from "./ids";
import { hostDoEndpoint, lerEndpointMcpExterno, type ServidorMcpExterno } from "./registro";
import { abrirChaveMcpExterno } from "./segredo";

/** Colunas que saem do jsonb porque a RLS entregava a chave a todo membro. */
const COLUNAS_DO_SEGREDO =
  "settings, mcp_externo_chave_encrypted, mcp_externo_chave_iv, mcp_externo_chave_tag";

/** O que o montador do turno recebe: a configuração e o que o servidor anunciou. */
export interface ServidorMcpExternoMontado {
  servidor: ServidorMcpExterno;
  ferramentas: readonly FerramentaRemota[];
  /**
   * JUNTA DE TESTE, o mesmo `fetchImpl` opcional que `allowlistedFetch` já
   * aceita: o stub do ERP de mentira mora em `127.0.0.1`, faixa que o guard
   * anti-SSRF recusa (item 4). `carregarServidorMcpExterno` NUNCA preenche
   * isto — quem monta este objeto em produção sai com o guard default.
   */
  fetch?: FetchLike;
  /**
   * O contato a que `cabecalhos` está amarrado. Presente só em turno com
   * contato e opção ligada — é por ele que `pickToolsFromMcp` deixa a leitura
   * remota montar num turno de conversa.
   */
  contato?: string;
  /** A identidade do contato (`CABECALHOS_DO_CONTATO`), lida do banco. */
  cabecalhos?: Readonly<Record<string, string>>;
}

export interface OpcoesDeCarga {
  /**
   * O CONTATO deste turno, quando há conversa. Presente sem `noAtendimento` =
   * nenhuma ferramenta remota é carregada (item 8, escolha (b)).
   */
  contatoDoTurno?: string;
  /** `ai_agents.config.mcp_externo_no_atendimento` do agente do turno. */
  noAtendimento?: boolean;
  /** A CONVERSA deste turno — de onde sai `X-Deskcomm-Canal`. */
  conversaDoTurno?: string;
  /** `fetch` de saída para a descoberta — teste stuba o ERP em `127.0.0.1`. */
  fetch?: FetchLike;
}

/** Canal como texto curto de banco — nada que quebre a linha do cabeçalho. */
const CANAL_VALIDO = /^[a-z_]{1,32}$/;

/**
 * Os cabeçalhos de identidade do contato, lidos do banco pelo id E pela
 * organização do turno. `null` quando o contato não resolve (erro de leitura,
 * contato de outra organização ou inexistente) — e aí o servidor não carrega.
 *
 * Telefone em dígitos E.164, sem o `+` (a coluna guarda `+5511...`); ausente
 * quando o contato não tem telefone. Canal da conversa DO TURNO (lida pelo id,
 * pela organização e pelo contato); ausente quando o turno não a informa ou
 * ela não resolve — ele é contexto, não identidade, e por isso a falha dele
 * não fecha a carga.
 */
async function cabecalhosDoContato(
  supabase: SupabaseClient,
  organizationId: string,
  contatoId: string,
  conversaId: string | undefined,
): Promise<Record<string, string> | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, phone_number")
    .eq("organization_id", organizationId)
    .eq("id", contatoId)
    .maybeSingle();
  const contato = data as { id?: unknown; phone_number?: unknown } | null;
  if (error || typeof contato?.id !== "string" || contato.id !== contatoId) {
    logger.warn("contato do turno nao resolvido — servidor MCP externo fica fora deste turno", {
      organization_id: organizationId,
      ...(error ? { error: error.message } : {}),
    });
    return null;
  }

  const cabecalhos: Record<string, string> = { [CABECALHOS_DO_CONTATO.id]: contato.id };
  const digitos =
    typeof contato.phone_number === "string" ? contato.phone_number.replace(/\D/g, "") : "";
  if (digitos !== "") cabecalhos[CABECALHOS_DO_CONTATO.telefone] = digitos;

  if (!conversaId) return cabecalhos;
  const { data: conversa } = await supabase
    .from("conversations")
    .select("channel")
    .eq("organization_id", organizationId)
    .eq("id", conversaId)
    .eq("contact_id", contatoId)
    .maybeSingle();
  const canal = (conversa as { channel?: unknown } | null)?.channel;
  if (typeof canal === "string" && CANAL_VALIDO.test(canal)) {
    cabecalhos[CABECALHOS_DO_CONTATO.canal] = canal;
  }
  return cabecalhos;
}

/**
 * `null` = não há servidor registrado, o turno tem contato sem a opção do
 * agente, o contato não resolveu, ou não deu para falar com o servidor. É o
 * contrato do chamador: `...(montado ? { servidorMcpExterno: montado } : {})`,
 * e sem essa chave o turno é o de sempre — catálogo compilado, rede nenhuma.
 */
export async function carregarServidorMcpExterno(
  supabase: SupabaseClient,
  organizationId: string,
  opcoes?: OpcoesDeCarga,
): Promise<ServidorMcpExternoMontado | null> {
  // ESCOLHA (b), item 8 — antes de ler banco nem de pensar em rede. Sem a
  // opção do agente, um turno com conversa não monta ferramenta remota: sem o
  // identificador do contato na chamada, a leitura remota não tem como saber
  // de QUAL cliente é o dado.
  if (opcoes?.contatoDoTurno && opcoes.noAtendimento !== true) return null;

  const { data, error } = await supabase
    .from("organizations")
    .select(COLUNAS_DO_SEGREDO)
    // SEMPRE o `organization_id` do run, nunca do corpo do pedido (item 2): a
    // mesma linha que a ação gravou é a única que este turno enxerga.
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    logger.warn("nao foi possivel ler o registro do servidor MCP externo", {
      organization_id: organizationId,
      error: error.message,
    });
    return null;
  }

  const linha = data as {
    settings?: unknown;
    mcp_externo_chave_encrypted?: unknown;
    mcp_externo_chave_iv?: unknown;
    mcp_externo_chave_tag?: unknown;
  } | null;

  const endpoint = lerEndpointMcpExterno(linha?.settings);
  const chave = abrirChaveMcpExterno({
    mcp_externo_chave_encrypted: linha?.mcp_externo_chave_encrypted as string | undefined,
    mcp_externo_chave_iv: linha?.mcp_externo_chave_iv as string | undefined,
    mcp_externo_chave_tag: linha?.mcp_externo_chave_tag as string | undefined,
  });
  if (!endpoint || !chave) return null;
  const servidor: ServidorMcpExterno = { endpoint, chave };

  const contato = opcoes?.contatoDoTurno;
  const cabecalhos = contato
    ? await cabecalhosDoContato(supabase, organizationId, contato, opcoes?.conversaDoTurno)
    : undefined;
  if (cabecalhos === null) return null;

  try {
    const ferramentas = await listarFerramentasDoServidor(servidor, {
      ...(opcoes?.fetch ? { fetch: opcoes.fetch } : {}),
      ...(cabecalhos ? { cabecalhos } : {}),
    });
    if (ferramentas.length === 0) {
      logger.warn("servidor MCP externo registrado nao anunciou nenhuma ferramenta", {
        organization_id: organizationId,
        // SÓ o host: o endpoint pode trazer querystring de terceiros, e este
        // logger é lido por gente que não precisa ver segredo alheio (item 5).
        endpoint: hostDoEndpoint(endpoint),
      });
      return null;
    }
    return contato && cabecalhos
      ? { servidor, ferramentas, contato, cabecalhos }
      : { servidor, ferramentas };
  } catch (err) {
    logger.warn("servidor MCP externo registrado nao respondeu — turno segue sem as ferramentas dele", {
      organization_id: organizationId,
      endpoint: hostDoEndpoint(endpoint),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A porta dos MONTADORES DE TURNO (`runAgent` e `buildMcpTurnTools`). Item 7 da
 * decisão: sem escolha `mcp_externo:*` no `tool_ids` do agente, NADA abre rede.
 *
 * A descoberta (`initialize` + `tools/list`, até 15 s cada) acontecia antes de
 * qualquer olhar para o `tool_ids` — a escolha só era lida dentro de
 * `pickToolsFromMcp`, que descartava o resultado. Com servidor registrado, todo
 * turno sem contato falava com o ERP, e com o ERP fora do ar esperava até 30 s,
 * mesmo para um agente que nunca marcou ferramenta remota. O gate mora aqui,
 * antes do banco e da rede, para os dois montadores passarem pelo mesmo.
 *
 * `listarFerramentasMcpExternas` (o editor do agente) segue chamando
 * `carregarServidorMcpExterno` direto: listar o que o servidor oferece é
 * justamente o passo ANTES de existir escolha.
 */
export async function carregarServidorMcpExternoDoTurno(
  supabase: SupabaseClient,
  organizationId: string,
  toolIds: readonly string[],
  opcoes?: OpcoesDeCarga,
): Promise<ServidorMcpExternoMontado | null> {
  if (escolhasRemotas(toolIds).length === 0) return null;
  return carregarServidorMcpExterno(supabase, organizationId, opcoes);
}
