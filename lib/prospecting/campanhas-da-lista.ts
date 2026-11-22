/**
 * A lista de campanhas que a tela da Prospecção desenha — e a contagem do cartão,
 * DERIVADA das linhas em vez de lida de um número guardado.
 *
 * Por que a contagem não vem de `prospecting_campaigns.result_count`: o cartão diz
 * "N empresas" sobre o que está NA LISTA, e a lista são as linhas de
 * `prospecting_candidates`. Enquanto o cartão leu o campo guardado, toda operação
 * que tira linha de uma campanha — o "Usar lista em outra campanha" (PR #4315),
 * a limpeza das desmarcadas e o expurgo por retenção — deixava o número para trás:
 * a campanha de origem ficava com 1 empresa e o cartão continuava dizendo 3 (#4947).
 * Guardar a contagem em dois lugares é o defeito; aqui ela tem um lugar só.
 *
 * Custo medido (100.000 empresas numa organização, 60 campanhas, pg17 do baseline):
 * ler o campo guardado 0,11 ms; esta contagem 21,4 ms por varredura de índice
 * (`prospecting_pending_campaign(organization_id,campaign_id,status)`, que já existe
 * no baseline). O MESMO request já busca todas as linhas da organização (até 5.000,
 * com cinco joins) para desenhar a tela — a contagem é estritamente menos trabalho
 * do que o que a rota faz de qualquer jeito, e não passa a existir um segundo número
 * para manter em sincronia.
 */
import type pg from "pg";

/** As colunas que o cartão consome. `result_count` é a contagem das linhas, não a coluna. */
export interface CampanhaDaLista {
  id: string;
  name: string;
  search: unknown;
  config: unknown;
  status: string;
  search_status: string;
  run_id: string | null;
  cost_usd: string | null;
  result_count: number;
  skipped_count: number;
  error: string | null;
  next_send_at: string;
  created_at: string;
  channel_session_id: string | null;
}

/**
 * As NÃO arquivadas vêm primeiro porque a lista é limitada a 50 e a tela separa as
 * duas (#4359): sem esta ordem, uma campanha arquivada ontem roubaria a vaga de uma
 * que ainda está trabalhando.
 *
 * O `left join` garante a campanha sem nenhuma linha com `0` (e não a some da lista).
 * A subconsulta conta por organização — a mesma varredura do índice que a página
 * já paga ao buscar as empresas da tela.
 */
export const CAMPANHAS_DA_LISTA_SQL = `select c.id,c.name,c.search,c.config,c.status,c.search_status,c.run_id,c.cost_usd,coalesce(k.empresas,0)::int as result_count,c.skipped_count,c.error,c.next_send_at,c.created_at,c.channel_session_id from prospecting_campaigns c left join (select campaign_id,count(*)::int as empresas from prospecting_candidates where organization_id=$1 group by campaign_id) k on k.campaign_id=c.id where c.organization_id=$1 order by (c.config->>'arquivada_em' is null) desc, c.created_at desc limit 50`;

export async function listarCampanhasDaLista(
  db: pg.Pool | pg.PoolClient,
  org: string,
): Promise<CampanhaDaLista[]> {
  const { rows } = await db.query<CampanhaDaLista>(CAMPANHAS_DA_LISTA_SQL, [org]);
  return rows;
}
