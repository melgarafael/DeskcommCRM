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
 * importação e Google Agenda sem conexão nem compromisso a empurrar — e, desde o
 * #3694 (crédito: @webtecnica), replay de webhook sem linha transitória,
 * follow-up sem inscrição vencida, pointer ou turno na fila, agendador de pausa
 * sem janela começada e proposta sem envio em curso. Cada uma dessas rotas ia
 * ao PostgREST
 * a cada minuto só para descobrir que a fila está vazia — e no plano grátis do
 * Supabase isso consome o projeto até o `PGRST002` derrubar a instalação.
 *
 * ─── O SINAL: um RETRATO em memória, alimentado por UMA consulta por janela ──
 *
 * O portão lê, de uma vez só, um `exists` por recurso e guarda o
 * resultado num mapa de PROCESSO com validade de `TTL_DO_RETRATO_MS` (30 s).
 *
 * Por que ele não custa requisição:
 *
 * - **Não é PostgREST.** A consulta vai pelo pool `pg` direto (`getRequestPool`),
 *   então não gasta a cota de requisições do PostgREST — é justamente a cota que
 *   o `PGRST002` estoura.
 * - **Uma por janela, não uma por rota.** Todas as rotas que consultam o portão
 *   dividem o MESMO retrato: ~60 consultas/h para a instalação inteira (uma
 *   por minuto, porque o crond dispara tudo no segundo 0 e o retrato de 30 s
 *   vence antes da batida seguinte), contra 60/h POR ROTA que cada uma fazia
 *   antes. Dentro da mesma batida, a resposta é do mapa.
 * - **Uma consulta, todos os recursos.** As perguntas cabem num `select`
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
 *
 * ─── QUEM CRIA TRABALHO NO PROCESSO AVISA (`invalidarRetrato`) ──────────────
 *
 * Para o que nasce fora deste processo (gatilho no banco, `agent-worker` em
 * outro contêiner), o atraso é o TTL — no máximo uma batida. Para o que nasce
 * aqui, não: a inscrição manual num fluxo (`lib/followup/enroll.ts`) e a batida
 * do follow-up que inscreveu, reclamou ou enfileirou trabalho chamam
 * `invalidarRetrato()`, e a batida seguinte relê. Medido no e2e
 * `followup-journey.spec.ts` (#3694): sem isso, os POSTs em rajada liam o
 * retrato de ANTES da inscrição e o enrollment ficava parado em `trigger-1`.
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
  "webhook_replay",
  "followup",
  "followup_silencio",
  "fila_followup",
  "pausa_de_canal",
  "propostas",
  "fila_de_soneca",
  "mensagem_presa",
  "ligacao_presa",
  "redacao_de_storage",
  "devolucao_de_handoff",
  "devolucao_ao_rodizio",
  "canal_vigiado",
  "mcp_a_revogar",
  "lembrete_de_tarefa",
  "lembrete_de_agenda",
] as const;
export type RecursoDoCron = (typeof RECURSOS_DO_CRON)[number];

/**
 * Validade do retrato. 30 s = ~60 consultas/h para a instalação inteira (uma
 * por batida do crond), contra 60/h POR ROTA antes. Mais que um minuto faria a
 * batida seguinte a ligar um recurso pular — e a campanha recém-ligada ficar
 * parada; a economia vem de as rotas dividirem o retrato e de ele ir pelo
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
 * Uma linha, um booleano por recurso. `exists` para na primeira linha encontrada — é o
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
 *   derrubaria o retrato inteiro, e as rotas voltariam a rodar sempre.
 * - os seis do #3694 são a condição EXATA da consulta que cada rota faz, ou um
 *   superconjunto dela: `webhook_events_log` sem o corte de espera de 2 min (a
 *   linha recém-arquivada nunca fica invisível) e sem o filtro de provider (o
 *   nome dele não sai de lib/channels/; mais largo é o lado seguro); `followup_enrollments` com o
 *   mesmo filtro da CTE de `fn_claim_due_followup_enrollments` (status vivo,
 *   vencido, sem lease, organização `active` — o teste do portão compara os
 *   dois); pointer `active` (o que `runSilenceSweep` varre); `followup_turn`
 *   `pending` (o dreno de texto fixo); janela `scheduled`/`running` já começada
 *   (`aplicarAgendas` não lê a que ainda vai começar); proposta `enviando` (o
 *   corte de 5 min continua sendo da rodada).
 *
 * ─── AS FILAS (segunda fatia do #3731) ─────────────────────────────────────
 *
 * Depois do #3753/#3707 o que sobrou de piso ocioso no crontab eram as rotas de
 * FILA: soneca vencida, mensagem presa, fila de redação de objeto, devolução de
 * handoff e ao rodízio, saúde de canal, revogação de MCP, lembrete de tarefa e
 * de agenda. Medido numa instalação parada: 15 `from()`/`rpc()` por batida de 5
 * min = **2,4 req/min (144/h)** — mais da metade do crontab que restava. As
 * nove linhas novas seguem a mesma regra das anteriores, e cada uma é
 * DELIBERADAMENTE mais larga que o predicado da rota, porque fechar o portão
 * com trabalho na fila é o defeito que este arquivo existe para não ter:
 *
 * - `mensagem_presa`: `sending` acima de 3 min, contra o corte de 5 min da rota
 *   (`STUCK_AFTER_MS`) — a folga cobre o relógio do portão e o da rodada;
 * - `ligacao_presa`: `starting`/`ringing` acima de 3 min, contra o corte de 5 min
 *   da rota (`STUCK_CALL_AFTER_MS`), pela mesma folga da `mensagem_presa`;
 * - `lembrete_de_tarefa`: a janela de ±1 dia de `janelaDaVarredura`, sem o
 *   filtro de organização parada, que a rodada aplica depois;
 * - `lembrete_de_agenda`: compromisso confirmado e futuro em 30 dias — a maior
 *   antecedência configurável (`MAIOR_ANTECEDENCIA_MS`), SEM o join do tipo de
 *   evento: tipo com lembrete desligado só mantém a rota acordada, que é o lado
 *   seguro;
 * - `devolucao_de_handoff`/`devolucao_ao_rodizio`: as mesmas quatro colunas que
 *   as rotas filtram, sem o prazo por organização (que muda por empresa e vive
 *   em `organizations`);
 * - `canal_vigiado`, `fila_de_soneca`, `redacao_de_storage`: a condição exata
 *   da consulta da rodada.
 *
 * Duas rodadas fazem MAIS do que a consulta principal, e o portão cobre as duas
 * (medido em `tests/invariants/piso-ocioso-retrato.test.ts`):
 *
 * - `mcp_a_revogar`: além da credencial vencida, a poda dos pedidos de
 *   autorização vencidos há mais de um dia (`revogarVencidas`);
 * - `lembrete_de_agenda`: além do compromisso futuro, o aviso de remetente
 *   aberto, que `fn_resolver_avisos_de_lembrete_expirados` resolve quando o
 *   compromisso já passou — sem ele o aviso ficava aberto na Central.
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
  ) as agenda_google_push,
  exists (
    select 1 from webhook_events_log
     where status = 'error' and error_message like 'transitoria:%'
  ) as webhook_replay,
  exists (
    select 1 from followup_enrollments e
     where e.status in ('active', 'waiting_reply', 'dormente')
       and e.next_eval_at <= now()
       and (e.claimed_until is null or e.claimed_until < now())
       and exists (select 1 from organizations o where o.id = e.organization_id and o.status = 'active')
  ) as followup,
  exists (
    select 1 from followup_flow_pointers where status = 'active'
  ) as followup_silencio,
  exists (
    select 1 from job_queue where kind = 'followup_turn' and status = 'pending'
  ) as fila_followup,
  exists (
    select 1 from channel_schedules
     where status in ('scheduled', 'running') and starts_at <= now()
  ) as pausa_de_canal,
  exists (
    select 1 from crm_proposals where status = 'enviando'
  ) as propostas,
  exists (
    select 1 from conversations
     where snooze_until is not null and snooze_until <= now()
  ) as fila_de_soneca,
  exists (
    select 1 from messages
     where direction = 'outbound' and status = 'sending'
       and created_at < now() - interval '3 minutes'
  ) as mensagem_presa,
  exists (
    select 1 from voice_calls
     where status in ('starting', 'ringing')
       and created_at < now() - interval '3 minutes'
  ) as ligacao_presa,
  exists (
    select 1 from storage_redaction_queue where status = 'pending'
  ) as redacao_de_storage,
  exists (
    select 1 from conversations
     where is_group = false
       and status in ('open', 'pending', 'claimed', 'ai_handling')
       and (bot_silenced_until is not null or assignee_kind = 'user' or assigned_to_user_id is not null)
  ) as devolucao_de_handoff,
  exists (
    select 1 from conversations
     where is_group = false
       and status in ('open', 'pending', 'claimed', 'ai_handling')
       and assigned_to_user_id is not null
  ) as devolucao_ao_rodizio,
  exists (
    select 1 from channel_sessions where archived_at is null
  ) as canal_vigiado,
  exists (
    select 1 from contato_mcp_credenciais
     where revogado_em is null and revogar_apos <= now()
  ) or exists (
    select 1 from mcp_oauth_pedidos where expira_em < now() - interval '1 day'
  ) as mcp_a_revogar,
  exists (
    select 1 from crm_tasks
     where status in ('pending', 'in_progress')
       and assigned_to is not null and due_date is not null
       and due_date between now() - interval '1 day' and now() + interval '1 day'
  ) as lembrete_de_tarefa,
  exists (
    select 1 from calendar_appointments
     where status = 'confirmed' and contact_id is not null
       and starts_at > now() and starts_at <= now() + interval '30 days'
  ) or exists (
    select 1 from agent_inbox_items
     where ref_kind = 'agenda_reminder_sender' and status = 'open'
  ) as lembrete_de_agenda
`;

type Retrato = { emUso: Record<RecursoDoCron, boolean>; ate: number };

let retrato: Retrato | null = null;
/**
 * A leitura em andamento. Sem ela, os crons que batem na mesma janela
 * (o crontab dispara vários no mesmo segundo) começariam uma leitura cada, em
 * paralelo — o retrato só existe depois do primeiro `await`, então todos veem
 * "vazio". Uma promessa dividida mantém a promessa do arquivo: uma leitura por
 * janela, não uma por rota.
 */
let carregando: Promise<Record<RecursoDoCron, boolean>> | null = null;
/**
 * Conta as invalidações. A leitura que já estava em voo quando alguém
 * invalidou NÃO pode gravar o retrato de antes do evento — seria devolver 30 s
 * de "nada a fazer" para o trabalho que acabou de nascer.
 */
let geracao = 0;

/** O banco do portão. Só `query` é usado — o pool inteiro não entra aqui. */
export type BancoDoPortao = Pick<pg.Pool, "query">;

function retratoCompleto(linha: Record<string, unknown> | undefined): Record<RecursoDoCron, boolean> {
  return Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, linha?.[r] === true])) as Record<RecursoDoCron, boolean>;
}

/** O retrato de "tudo em uso" — o lado seguro, usado quando a leitura falha. */
const TUDO_EM_USO = Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, true])) as Record<RecursoDoCron, boolean>;

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
  const minhaGeracao = geracao;
  carregando ??= lerRetrato(db);
  const emUso = await carregando;
  // Só grava se ninguém invalidou no meio do caminho (ver `geracao`).
  if (geracao === minhaGeracao) {
    carregando = null;
    retrato = { emUso, ate: agora + TTL_DO_RETRATO_MS };
  }
  return emUso[recurso];
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

/**
 * Esquece o retrato: a próxima batida relê. Quem cria trabalho DENTRO deste
 * processo chama (ver "Quem cria trabalho no processo avisa", no cabeçalho);
 * o resto espera o TTL.
 */
export function invalidarRetrato(): void {
  retrato = null;
  carregando = null;
  geracao += 1;
}

/** O nome que os testes usam para zerar o estado entre casos. */
export const esquecerRetrato = invalidarRetrato;

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
