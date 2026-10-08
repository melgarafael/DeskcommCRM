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
 * ── Por que o TURNO COM CONTATO não ganha servidor nenhum (item 8, escolha b) ─
 *
 * O servidor remoto não recebe o `ctx.contatoDoTurno`, então uma leitura
 * remota durante a conversa poderia devolver dado de OUTRO cliente ao modelo —
 * e do modelo ao contato. Até existir identificação forçada do contato na
 * chamada, quem decide é aqui: turno com contato não carrega servidor, e o
 * turno é o de sempre. Cobre o Conversador e o Operador, que os dois montam
 * ferramentas passando o contato do turno.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { logger } from "@/lib/logger";
import { listarFerramentasDoServidor, type FerramentaRemota } from "./chamada";
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
}

export interface OpcoesDeCarga {
  /**
   * O CONTATO deste turno, quando há conversa. Presente = nenhuma ferramenta
   * remota é carregada (item 8, escolha (b)).
   */
  contatoDoTurno?: string;
  /** `fetch` de saída para a descoberta — teste stuba o ERP em `127.0.0.1`. */
  fetch?: FetchLike;
}

/**
 * `null` = não há servidor registrado, o turno tem contato, ou não deu para
 * falar com ele. É o contrato do chamador: `...(montado ?
 * { servidorMcpExterno: montado } : {})`, e sem essa chave o turno é o de
 * sempre — catálogo compilado, rede nenhuma.
 */
export async function carregarServidorMcpExterno(
  supabase: SupabaseClient,
  organizationId: string,
  opcoes?: OpcoesDeCarga,
): Promise<ServidorMcpExternoMontado | null> {
  // ESCOLHA (b), item 8 — antes de ler banco nem de pensar em rede. Um turno
  // com conversa não monta ferramenta remota: sem o identificador do contato
  // na chamada, a leitura remota não tem como saber de QUAL cliente é o dado.
  if (opcoes?.contatoDoTurno) return null;

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

  try {
    const ferramentas = await listarFerramentasDoServidor(servidor, {
      ...(opcoes?.fetch ? { fetch: opcoes.fetch } : {}),
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
    return { servidor, ferramentas };
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
