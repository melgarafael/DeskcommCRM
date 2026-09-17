-- 0261 — o título do evento pessoal do Google sai do alcance do membro
--
-- ─── O que estava aberto, e foi medido ──────────────────────────────────────
--
-- `public.calendar_external_events` é o espelho da agenda PESSOAL de quem
-- atende: o compromisso que a pessoa sincronizou só para bloquear o próprio
-- horário — "Consulta médica", "Terapia", "entrevista de emprego".
--
-- O papel `authenticated` tinha SELECT de TABELA nesta tabela — vindo do default
-- ACL de TABELAS do Supabase (que o dump também reemite, `ALTER DEFAULT
-- PRIVILEGES … GRANT ALL ON TABLES`): a tabela nasce no apêndice do baseline, e
-- não há `GRANT` dela no dump —, e a view
-- `calendar_selected_external_events` era `select e.*` — com o `title` dentro.
-- Num banco instalado do zero (`baseline.sql` da v1.26.0), um membro de OUTRO
-- papel, inclusive Somente leitura, lia o `title` de uma linha do colega — com o
-- título INSERIDO À MÃO, ver o alcance logo abaixo:
--
--     select title from public.calendar_external_events …   → "Terapia sigilosa"
--
-- tanto direto na tabela quanto pela view; e
-- `has_column_privilege('authenticated','calendar_external_events','title','SELECT')`
-- respondia `true`.
--
-- ─── O alcance real: o privilégio estava aberto; o nome, quase nunca ────────
--
-- O título daquela medição foi inserido à mão (a fixture do invariante roda como
-- superusuário). Numa instalação v1.17.0 ou mais nova o único escritor do
-- produto grava o título nulo (ver "Quem ainda alcança o título", abaixo), então
-- não há nome para ler. O nome só existe em linhas gravadas pelo cron anterior à
-- v1.17.0 (`app/api/v1/cron/agenda-google-sync`, que fazia
-- `title: lido.evento.title`) e que a ressincronização ainda não regravou: o
-- rebuild completo, a cada 24h, regrava de 1 dia atrás a 90 dias à frente; o
-- passado espera o expurgo do espelho (`fn_expurgar_espelho_da_agenda`, por
-- padrão 90 dias depois de `ends_at`); e há agendas que o sincronizador não lê,
-- cujas linhas ficam com o nome inteiro — futuras inclusive — até o expurgo:
--
-- * a de conexão que não está saudável e a de membro revogado —
--   `fn_google_calendar` recusa a reserva com `google_connection_unavailable`;
-- * a que saiu do catálogo do Google (`available=false`) — a reserva não sai;
-- * a desmarcada: não conta para conflito, não é destino e não tem agendamento
--   vinculado — o cron a adia 24h e segue, sem chamar a reserva
--   (`app/api/v1/cron/agenda-google-sync/route.ts`).
--
-- As três primeiras o invariante mede; a quarta mora no cron.
--
-- E nem tudo o que está DENTRO da janela é regravado. O evento CANCELADO escapa
-- do rebuild: o `page` que o fecha apaga o que a leitura não viu com `and
-- status<>'cancelled'`, e a leitura completa do Google não devolve cancelados,
-- então nenhum `item` o zera. Um cancelado FUTURO guarda o nome até o expurgo, 90
-- dias depois de terminar — o invariante mede, com o controle de que o confirmado
-- que sumiu do Google, no mesmo rebuild, é apagado. Não é só "o que já passou".
--
-- É esse resíduo que o conserto fecha — e ele vale também como defesa em
-- profundidade contra um escritor futuro que volte a gravar o nome.
--
-- ─── Por que o conserto é no PRIVILÉGIO — e o que a policy fecharia ────────
--
-- O que o CRM usa de um evento do Google é ocupado/livre (`starts_at`,
-- `ends_at`, `transparency`, `status`); o `title` não tem consumidor nenhum na
-- tela. Isso é vigiado do lado da tela por
-- `tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts` (as leituras da tela
-- da Agenda e da rota de agendamentos, pela tabela ou pela view, não pedem a
-- coluna) e por `tests/e2e/agenda-ocupacao-do-google-na-grade.spec.ts` (o título
-- não aparece no texto nem no HTML da grade); do lado do banco, pela própria view
-- sem `title`.
--
-- Então o SELECT de `authenticated` sai da TABELA e volta COLUNA A COLUNA, sem o
-- `title`. Revogar a coluna sem revogar a tabela não faria nada: o privilégio de
-- TABELA cobre todas as colunas, e é ele que o default ACL de tabelas concede.
--
-- A policy de leitura (`calendar_external_events_select`) segue sendo da
-- ORGANIZAÇÃO, e esta migration não a toca. Uma versão anterior deste cabeçalho
-- dizia que era assim de propósito, porque "a grade da equipe mostra a ocupação
-- do colega", e que restringi-la "apagaria a ocupação de todo mundo". Não é o
-- que o produto faz — medido:
--
-- * as duas leituras de tela (`app/app/agenda/page.tsx` e
--   `app/api/v1/agenda/agendamentos/route.ts`) usam a sessão do usuário e pedem
--   a view com o embed `calendar_connections!inner(user_id)`. A RLS de
--   `calendar_connections` mostra a conexão só ao dono e a quem é manager ou
--   acima, e o `!inner` tira da resposta a linha cuja conexão o leitor não vê.
--   Para Somente leitura e Atendente, a grade de HOJE já não mostra a ocupação do
--   Google do colega, antes e depois desta migration (issue #879);
-- * quem entrega essa ocupação a todo membro é
--   `fn_agenda_ocupacao_google_do_dono` (0260), `security definer`, que o encaixe
--   de horários chama (`lib/agenda/consulta.ts`) — e que policy nenhuma alcança.
--
-- Numa transação desfeita, com a policy trocada por "dono da conexão OU manager
-- ou acima" (a régua de `calendar_connection_calendars_select`): Somente leitura
-- e Atendente passaram a ler 0 linha na tabela e na view, a leitura da tela deles
-- seguiu com 0, e a função da 0260 seguiu devolvendo a ocupação a eles; dono e
-- gestor seguiram com a tela inteira. É o fechamento mais barato do que fica
-- aberto na seção seguinte, e não pede mudar leitura nenhuma. Não entra aqui
-- porque muda QUEM lê o espelho, e não só que coluna: é decisão do dono.
--
-- ─── O que continua ao alcance do membro, e por quê ─────────────────────────
--
-- O `title` NÃO é o único dado pessoal do espelho. `external_calendar_id` é o
-- `id` do CalendarList do Google (`fn_google_catalog` grava `it->>'id'`), e na
-- agenda PRINCIPAL — a que conta por padrão — esse id é o e-mail da conta
-- conectada. A RLS de `calendar_connections` esconde essa conta de um colega que
-- não é gestor; esta tabela e a view a entregam a todo membro da organização.
-- `external_event_id` (o id do evento na agenda do Google) também segue concedido.
--
-- E `ical_uid` também — mas ele não é um identificador do Google. É o UID do RFC
-- 5545 que o sistema de QUEM CRIOU o evento gerou (`evento.iCalUID`,
-- `lib/agenda/google/evento.ts`): num convite de fora, o formato e o domínio de
-- quem convidou. E é resíduo do MESMO período do `title`: só o cron anterior à
-- v1.17.0 o gravava (v1.16.1, `app/api/v1/cron/agenda-google-sync/route.ts`,
-- `ical_uid: lido.evento.ical_uid`). Desde a 0225 nenhuma função o grava — o
-- executor ainda o manda no payload, e `fn_google_calendar` o ignora —, e o `on
-- conflict` dela não o põe no `set`. Então, ao contrário do `title`, a
-- ressincronização NÃO o limpa: o valor antigo sobrevive ao reprocessamento que
-- anula o título (o invariante mede). O conteúdo real desses UIDs em convites de
-- fora não foi medido. Fechá-lo cabe na policy da seção anterior ou na migration
-- que anular o resíduo — as duas, decisão do dono.
--
-- Esta migration deixa isso aberto, e por escrito. Revogar a COLUNA não serve: a
-- view é `security_invoker` e passa `e.external_calendar_id` a
-- `fn_google_counts_for_conflicts`, então revogá-la faz TODA leitura da view por
-- membro falhar com `permission denied for table calendar_external_events` — a do
-- próprio dono inclusive (medido). O que fecha é a policy "dono da conexão OU
-- manager ou acima" da seção anterior: tira o id de Somente leitura e de
-- Atendente sem tocar em tela nem em rota, e não entrega ao gestor nada que ele
-- já não leia — ele lê `account_email` em `calendar_connections`. É decisão do
-- dono, fora deste conserto. Um caso do invariante mede que o colega segue lendo
-- o id — no dia em que alguém fechar, ele fica vermelho e esta seção muda junto.
--
-- ─── A view precisa ser recriada, não substituída no lugar ──────────────────
--
-- `calendar_selected_external_events` era `select e.*`. Com `security_invoker`,
-- o Postgres confere privilégio de coluna EM NOME DO INVOCADOR para toda coluna
-- referenciada na definição — inclusive as de um `e.*` já expandido quando a
-- view nasceu. Deixá-la assim faria TODA leitura de ocupação por membro falhar
-- com `permission denied` no `title`. E `create or replace view` não aceita
-- tirar coluna do meio (o Postgres recusa: "cannot drop columns from view"):
-- daí o `drop` + `create` com lista explícita. A lista explícita é o conserto de
-- fundo — `e.*` era a forma de a próxima coluna nascer exposta.
--
-- ─── Quem ainda alcança o título ────────────────────────────────────────────
--
-- `service_role`, que esta migration não toca, mantém SELECT/UPDATE na coluna —
-- mas nenhum caminho do produto usa esse privilégio. O sincronizador não grava
-- com ele: `fn_google_calendar` é `security definer`, só `service_role` a
-- executa, e o `insert … on conflict` roda com o privilégio do DONO da função.
-- Desde a 0225 (v1.17.0, PR #613) ela grava `title` NULO — ação `item`, `null`
-- no insert e `set title=null` no `on conflict`, zerando o que encontra; o
-- executor (`lib/agenda/google/calendar-executor.ts`) já manda `title: null`. O
-- único privilégio de TABELA do `service_role` que o produto usa é o da
-- desconexão (`app/api/v1/agenda/google/desconectar/route.ts`): DELETE, e SELECT
-- nas colunas do filtro. O invariante mede cada caminho pelo que ele usa: o
-- `service_role` chama o sincronizador com dois eventos com `title` no payload e
-- o espelho fica com os dois títulos nulos — igual com todo privilégio de tabela
-- do papel revogado —, e a desconexão apaga com o DELETE do papel.
--
-- E nenhuma função nem view que `authenticated` ou `anon` alcance lê o título.
-- Isso importa porque o grant de coluna fecha o LOGIN, não quem lê com o
-- privilégio do dono: uma `security definer` com EXECUTE para `authenticated`
-- que devolva `e.title` entrega o nome ao colega com todas as asserções de
-- privilégio verdes (medido numa transação desfeita). O invariante varre
-- `pg_proc` e as views de `public` atrás de quem cita o espelho junto com `title`
-- ou com a linha inteira (`e.*`, `to_jsonb`, `json_agg` da linha) e reprova a que
-- o login alcança; hoje a única que cita o título é `fn_google_calendar`, que só
-- `service_role` executa, para gravá-lo nulo. A varredura não enxerga SQL
-- dinâmico que monte o nome da tabela por partes, nem função de outro schema.
--
-- Nenhum login de usuário lê o título depois desta migration — nem o colega, nem
-- o próprio dono da conexão. Nenhuma tela mostra o título de um evento externo —
-- os guardas de tela citados acima vigiam isso —, então não há leitura de
-- titular a preservar nos papéis do PostgREST; se um dia houver uma tela do
-- titular, ela nasce com função `security definer` própria — e a varredura do
-- invariante a reprova até ele mudar junto, de propósito.
--
-- ─── O que esta migration NÃO faz, de propósito ─────────────────────────────
--
-- * Não apaga os títulos que sobraram de sincronizações anteriores à v1.17.0 (a
--   0225 deixou de gravá-los, mas não anulou os que já estavam lá), nem os
--   `ical_uid` do mesmo período, que nem a ressincronização limpa. O que se
--   fecha é a LEITURA por login de usuário. Anular o resíduo é decisão do dono e
--   sai em migration própria, não de carona num conserto de permissão.
-- * Não concede nada a `anon`, que segue sem privilégio nesta tabela desde a
--   0177 (`revoke all … from anon`).
--
-- ─── Forma ──────────────────────────────────────────────────────────────────
--
-- `revoke`, `grant`, `drop view if exists` são idempotentes: o `update.sh` de um
-- clone reaplica à vontade. O apêndice rotulado do `baseline.sql` traz o mesmo
-- bloco para quem instala do zero. Vigiado por
-- `tests/invariants/titulo-do-evento-pessoal-fora-do-alcance.test.ts`.
--
-- Duas consequências da forma, para quem mexer depois:
-- * O grant é por LISTA de colunas: coluna nova no espelho nasce SEM SELECT para
--   `authenticated`. É o lado seguro, e é uma decisão — o invariante reprova até
--   alguém escrever se ela vai ao alcance do membro (entra no grant e na lista da
--   view, que andam juntos, senão `select *` na view vira 42501) ou não. Estar no
--   grant não quer dizer "não é pessoal": ver `external_calendar_id`, acima.
-- * Quem LER esta view de dentro de função não pode usar `begin atomic`: a
--   dependência registrada no catálogo impede o `drop view` + `create view` que
--   o `update.sh` reaplica. Hoje o único leitor é
--   `fn_agenda_ocupacao_google_do_dono` (0260), `language sql` sem `begin
--   atomic`. `fn_google_counts_for_conflicts` não entra nessa conta: ela não lê
--   a view, é a view que a chama — e uma view que chama função `begin atomic` é
--   removida sem erro (medido no pg15; o contrário, função `begin atomic` lendo a
--   view, dá "cannot drop view … because other objects depend on it").

revoke select on public.calendar_external_events from authenticated;

grant select (
  id, organization_id, connection_id, external_calendar_id, external_event_id,
  starts_at, ends_at, is_all_day, status, transparency, external_updated_at,
  created_at, updated_at, ical_uid, seen_generation, recurring_event_id,
  original_start_time
) on public.calendar_external_events to authenticated;

drop view if exists public.calendar_selected_external_events;

create view public.calendar_selected_external_events
with (security_invoker = true) as
select
  e.id, e.organization_id, e.connection_id, e.external_calendar_id,
  e.external_event_id, e.starts_at, e.ends_at, e.is_all_day, e.status,
  e.transparency, e.external_updated_at, e.created_at, e.updated_at,
  e.ical_uid, e.seen_generation, e.recurring_event_id, e.original_start_time
from public.calendar_external_events e
where e.status <> 'cancelled'
  and public.fn_google_counts_for_conflicts(e.organization_id, e.connection_id, e.external_calendar_id);

revoke all on public.calendar_selected_external_events from public, anon;

grant select on public.calendar_selected_external_events to authenticated, service_role;

notify pgrst, 'reload schema';
