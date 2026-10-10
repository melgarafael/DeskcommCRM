-- 0193 — a conexão do Google era um ponteiro sem FK, e o fuso dela não tinha onde morar.
--
-- Duas ausências na 0177, achadas por varredura de ausência (não por leitura), e as duas
-- da mesma família: a falha não aparece como linha errada, aparece como linha AUSENTE.
--
-- (1) `calendar_appointments.google_connection_id` é a ÚNICA das nove colunas-ponteiro
--     daquela tabela sem `references` — as outras oito trazem FK com `on delete` explícito
--     E comentário justificando a escolha. É o anti-pattern nº 4 do CLAUDE.md ("FK ausente
--     que vira inferência por nome"), e hoje ele não custa nada porque o escritor de ida
--     ainda não nasceu. Custa no dia em que nascer — e aí o órfão é construtível.
--     `set null` e não `cascade`: se a conexão do Google sumir, o compromisso NÃO some com
--     ela. Ele existe no CRM por direito próprio e só perde o ponteiro; apagá-lo seria
--     cascade fantasma (anti-pattern nº 7), destruindo histórico por causa de uma
--     integração revogada.
--
-- (2) O fuso do calendário é buscado do Google, gasto como metadado de auditoria e
--     DESCARTADO, porque não existe coluna onde guardá-lo — o sync crava `fuso: null` e o
--     fallback `?? 'UTC'` dispara SEMPRE. Em `America/Sao_Paulo` um evento de dia inteiro
--     bloqueia das 21h do dia anterior às 21h do dia seguinte: a noite do próprio dia vaza.
--     A coluna vai em `calendar_connection_calendars` e não em `calendar_connections`
--     porque o Google devolve `timeZone` POR CALENDÁRIO — guardar na conexão achataria N
--     em 1, e uma conexão com dois calendários em fusos diferentes passaria a mentir sobre
--     um dos dois.
--
-- Por que forward-fix em vez de editar a 0177: ela já vive em QUATORZE branches, com o
-- baseline aplicado. O `create table` do baseline é `if not exists`, então banco já criado
-- não recebe coluna por reescrita do create — o statement inteiro vira no-op. Editar a
-- 0177 não alcançaria nenhuma das quatorze.

alter table public.calendar_appointments
  add column if not exists google_connection_id uuid;

-- Backfill ANTES da constraint: a coluna é nova e nada escreve nela hoje, mas um clone
-- adiantado poderia ter linha com ponteiro morto — e constraint criada sobre dado que a
-- viola quebra o `update.sh` do clone, que roda SEM ON_ERROR_STOP e falharia no meio.
update public.calendar_appointments a
   set google_connection_id = null
 where a.google_connection_id is not null
   and not exists (select 1 from public.calendar_connections c where c.id = a.google_connection_id);

do $fk$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.calendar_appointments'::regclass
       and conname = 'calendar_appointments_google_connection_id_fkey'
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_google_connection_id_fkey
      foreign key (google_connection_id)
      references public.calendar_connections(id) on delete set null;
  end if;
end
$fk$;

comment on column public.calendar_appointments.google_connection_id is
  'Conexão do Google que espelha este compromisso. `set null`: conexão revogada não apaga compromisso — ele é do CRM, não da integração.';

alter table public.calendar_connection_calendars
  add column if not exists time_zone text;

comment on column public.calendar_connection_calendars.time_zone is
  'Fuso IANA do calendário, como o Google devolve (`timeZone`). NULL = ainda não sincronizado; quem lê deve tratar NULL como "não sei", nunca como UTC — foi o `?? UTC` que fez evento de dia inteiro vazar a noite anterior.';
