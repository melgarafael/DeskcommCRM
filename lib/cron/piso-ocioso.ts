/**
 * O PISO OCIOSO DO CRON (#3731, parte 1) — a saída antecipada que NÃO custa
 * requisição ao Supabase.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Numa instalação ociosa, o `event_log` e ~13,9 chamadas/min do crontab
 * (`docker/scheduler/entrypoint.sh`) sustentam ~44 req/min enquanto ninguém usa
 * o produto. Boa parte delas é de recurso que a organização NÃO TEM LIGADO:
 * prospecção sem campanha, campanhas sem campanha, importação de histórico sem
 * importação e Google Agenda sem conexão nem compromisso a empurrar. Cada uma
 * dessas rotas ia ao PostgREST
 * a cada minuto só para descobrir que a fila está vazia — e no plano grátis do
 * Supabase isso consome o projeto até o `PGRST002` derrubar a instalação.
 *
 * ─── O SINAL: um RETRATO em memória, alimentado por UMA consulta por janela ──
 *
 * O portão lê, de uma vez só, cinco `exists` (um por recurso) e guarda o
 * resultado num mapa de PROCESSO com validade de `TTL_DO_RETRATO_MS` (30 s).
 *
 * Por que ele não custa requisição:
 *
 * - **Não é PostgREST.** A consulta vai pelo pool `pg` direto (`getRequestPool`),
 *   então não gasta a cota de requisições do PostgREST — é justamente a cota que
 *   o `PGRST002` estoura.
 * - **Uma por janela, não uma por rota.** As cinco rotas que consultam o portão
 *   dividem o MESMO retrato: ~60 consultas/h para a instalação inteira (uma
 *   por minuto, porque o crond dispara tudo no segundo 0 e o retrato de 30 s
 *   vence antes da batida seguinte), contra 60/h POR ROTA que cada uma fazia
 *   antes. Dentro da mesma batida, a resposta é do mapa.
 * - **Uma consulta, cinco recursos.** As cinco perguntas cabem num `select`
 *   só; consultas separadas seriam o mesmo custo multiplicado.
 *
 * O que NÃO se perde: a 1ª batida depois de ligar um recurso já roda. Um TTL
 * de minutos economizaria mais e quebraria a promessa da tela da campanha
 * ("Envio rápido: sai tudo em cerca de {n} min.") — com 5 min, a campanha
 * recém-ligada esperava quatro batidas paradas. 30 s dá uma leitura por
 * minuto com folga; 55 s deixaria só ~5 s entre a batida e o vencimento.
 *
 * ─── A REGRA DE FALHA: na dúvida, RODA ──────────────────────────────────────
 *
 * Erro de leitura (tabela ausente numa instalação antiga, banco fora, pool sem
 * `SUPABASE_DB_URL`) = `true`, ou seja, a rota segue o caminho normal. Este
 * portão existe para economizar cota, não para decidir se um recurso funciona:
 * um "não sei" que virasse "desligado" apagaria a prospecção de quem tem
 * campanha rodando, e o sintoma apareceria dias depois, sem log de erro.
 * O retrato com falha também fica em cache pela mesma janela — senão a leitura
 * quebrada voltaria a ser uma consulta por minuto, que é o que este arquivo
 * veio remover.
 */
import type pg from "pg";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";

/** Os recursos cujo cron pode ficar ocioso sem que a organização perca nada. */
export const RECURSOS_DO_CRON = [
  "prospeccao",
  "campanhas",
  "historico",
  "agenda_google",
  "agenda_google_push",
] as const;
export type RecursoDoCron = (typeof RECURSOS_DO_CRON)[number];

/**
 * Validade do retrato. 30 s = ~60 consultas/h para a instalação inteira (uma
 * por batida do crond), contra 60/h POR ROTA antes. Mais que um minuto faria a
 * batida seguinte a ligar um recurso pular — e a campanha recém-ligada ficar
 * parada; a economia vem de as cinco rotas dividirem o retrato e de ele ir pelo
 * pool `pg`, não de o TTL ser longo.
 */
export const TTL_DO_RETRATO_MS = 30_000;

/**
 * Teto da consulta do retrato. Um banco que aceita conexão e não responde não
 * pode segurar um cron de minuto a minuto: passado o teto, vale a regra de falha
 * (roda) e o resultado fica em cache como qualquer outro.
 */
const TETO_DA_LEITURA_MS = 2_000;

/**
 * Uma linha, cinco booleanos. `exists` para na primeira linha encontrada — é o
 * predicado mais barato que responde "esta fila tem trabalho?" sem contar nada.
 *
 * As colunas de status são as mesmas que as rotas já filtram:
 * - `prospecting_campaigns`: `draft`/`paused` também contam — elas têm
 *   candidatos que a rodada promove (`draft -> running`), então "só running"
 *   deixaria a promoção sem tick.
 * - `campaigns`: `scheduled` é a fila que o worker promove para `running`.
 * - `historico` (a rota anda a importação de histórico E as recuperações de queda
 *   do número, Spec 32): importação `rodando` ou `aguardando` (a recuperação nasce
 *   `aguardando`); saída de `WORKING` nos últimos 8 dias no `event_log` (7 de olhar
 *   para trás + 1 de folga, as constantes de `lib/channels/historico/quedas.ts`) —
 *   é o que abre uma recuperação; e aviso aberto da queda, que a rota fecha quando o
 *   cliente é respondido. O predicado é mais LARGO que o trabalho (uma queda já
 *   recuperada mantém a rota ligada por 8 dias): o lado seguro, como o do push.
 * - `calendar_connections`: só conexão saudável sincroniza; `google_calendar` é
 *   o único valor que o CHECK da coluna aceita. Vale para o SYNC, que filtra
 *   `healthy` na rota.
 * - `calendar_appointments` (o PUSH): o mesmo `or` de `googlePushCandidates`
 *   (lib/agenda/google/candidates.ts), SEM filtro de status da conexão — a rota
 *   não tem: compromisso de conexão que precisa de atenção recebe o aviso
 *   "Confira a conexão" pelo executor, e um portão por `healthy` o deixaria
 *   pendente calado. Lê a tabela, não a view `calendar_service_google_candidates`:
 *   sem os filtros da view (dono, publicação, anonimizado) e sem o de
 *   `google_next_attempt_at`, o predicado é mais LARGO que o da rota, que é o
 *   lado seguro com cache — e não depende do GRANT da view (o baseline o dá
 *   explicitamente só ao `service_role`): uma role menor no pool sem ele
 *   derrubaria o retrato inteiro, e as cinco rotas voltariam a rodar sempre.
 */
const SQL_DO_RETRATO = `
select
  exists (
    select 1 from prospecting_campaigns
     where status in ('running', 'draft', 'paused')
        or search_status in ('starting', 'running')
  ) as prospeccao,
  exists (
    select 1 from campaigns where status in ('running', 'scheduled')
  ) as campanhas,
  (
    exists (
      select 1 from importacoes_de_historico where status in ('rodando', 'aguardando')
    )
    or exists (
      select 1 from event_log
       where event_type = 'channel_session.status_changed'
         and payload ->> 'from_status' = 'WORKING'
         and created_at > now() - interval '8 days'
    )
    or exists (
      select 1 from agent_inbox_items
       where status = 'open'
         and kind in ('recuperacao_da_queda', 'cliente_sem_resposta_na_queda')
    )
  ) as historico,
  exists (
    select 1 from calendar_connections
     where status = 'healthy' and provider = 'google_calendar'
  ) as agenda_google,
  exists (
    select 1 from calendar_appointments
     where needs_google_push
        or (google_event_id is not null and google_conflict is null)
        or google_conflict -> 'resolution' is not null
  ) as agenda_google_push
`;

type Retrato = { emUso: Record<RecursoDoCron, boolean>; ate: number };

let retrato: Retrato | null = null;
/**
 * A leitura em andamento. Sem ela, os cinco crons que batem na mesma janela
 * (o crontab dispara vários no mesmo segundo) começariam CINCO leituras em
 * paralelo — o retrato só existe depois do primeiro `await`, então todos veem
 * "vazio". Uma promessa dividida mantém a promessa do arquivo: uma leitura por
 * janela, não uma por rota.
 */
let carregando: Promise<Record<RecursoDoCron, boolean>> | null = null;

/** O banco do portão. Só `query` é usado — o pool inteiro não entra aqui. */
export type BancoDoPortao = Pick<pg.Pool, "query">;

function retratoCompleto(linha: Record<string, unknown> | undefined): Record<RecursoDoCron, boolean> {
  const ligado = (v: unknown) => v === true;
  return {
    prospeccao: ligado(linha?.prospeccao),
    campanhas: ligado(linha?.campanhas),
    historico: ligado(linha?.historico),
    agenda_google: ligado(linha?.agenda_google),
    agenda_google_push: ligado(linha?.agenda_google_push),
  };
}

/** O retrato de "tudo em uso" — o lado seguro, usado quando a leitura falha. */
const TUDO_EM_USO: Record<RecursoDoCron, boolean> = {
  prospeccao: true,
  campanhas: true,
  historico: true,
  agenda_google: true,
  agenda_google_push: true,
};

function comTeto<T>(promessa: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const relogio = setTimeout(() => reject(new Error(`leitura do retrato passou de ${ms} ms`)), ms);
    promessa.then(
      (valor) => {
        clearTimeout(relogio);
        resolve(valor);
      },
      (erro) => {
        clearTimeout(relogio);
        reject(erro);
      },
    );
  });
}

async function lerRetrato(db?: BancoDoPortao): Promise<Record<RecursoDoCron, boolean>> {
  try {
    const banco = db ?? getRequestPool();
    const { rows } = await comTeto(
      Promise.resolve(banco.query(SQL_DO_RETRATO)) as Promise<{ rows: unknown[] }>,
      TETO_DA_LEITURA_MS,
    );
    return retratoCompleto(rows[0] as Record<string, unknown> | undefined);
  } catch (erro) {
    // Falha fechada ao contrário: "não sei" vira "tem trabalho" e a rota segue.
    logger.warn("piso ocioso do cron: leitura do retrato falhou — as rotas seguem o caminho normal", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return TUDO_EM_USO;
  }
}

/**
 * `true` = o recurso tem trabalho nesta instalação, a rota deve rodar.
 * `false` = fila vazia, a rota pode sair ANTES de qualquer outra ida ao banco.
 *
 * `agora` e `db` são pontos de injeção do teste (`lib/cron/piso-ocioso.test.ts`);
 * nenhuma rota os passa.
 */
export async function recursoTemTrabalho(
  recurso: RecursoDoCron,
  agora: number = Date.now(),
  db?: BancoDoPortao,
): Promise<boolean> {
  if (retrato !== null && retrato.ate > agora) return retrato.emUso[recurso];
  carregando ??= lerRetrato(db);
  const emUso = await carregando;
  carregando = null;
  retrato = { emUso, ate: agora + TTL_DO_RETRATO_MS };
  return retrato.emUso[recurso];
}

/**
 * O atalho que as rotas chamam: `true` = pode sair.
 *
 * Existe para a rota não repetir `!(await recursoTemTrabalho(...))` — a negação
 * dupla é o tipo de detalhe que alguém "conserta" ao revisar e transforma a
 * saída antecipada em `return` prematuro do caminho normal.
 */
export async function recursoOcioso(
  recurso: RecursoDoCron,
  agora: number = Date.now(),
  db?: BancoDoPortao,
): Promise<boolean> {
  return !(await recursoTemTrabalho(recurso, agora, db));
}

/** Esquece o retrato. Só o teste usa — em produção o TTL é quem manda. */
export function esquecerRetrato(): void {
  retrato = null;
  carregando = null;
}

/**
 * Semeia o retrato sem tocar no banco. Só o teste usa (`tests/unit/piso-ocioso-dos-crons.test.ts`):
 * as rotas chamam `recursoOcioso(recurso)` sem argumentos, então este é o único
 * jeito de exercitar a saída antecipada de cada rota pelo caminho REAL do
 * portão, sem depender de banco nem de mock do módulo (mock de módulo vaza
 * entre arquivos da suíte — medido nesta entrega).
 */
export function semearRetrato(
  emUso: Record<RecursoDoCron, boolean>,
  ate: number = Date.now() + TTL_DO_RETRATO_MS,
): void {
  retrato = { emUso, ate };
  carregando = null;
}
