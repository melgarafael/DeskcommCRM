-- manifest: **Lembrete ao dono antes de cada horário, com o link da reunião:** `config_aviso_de_agendamento.lembrar_antes` (nasce desligado), entrega `tipo='lembrete'` em `entregas_de_aviso_de_agendamento` com `degrau_minutos` e `inicio_lembrado` e chave única por (organização, compromisso, destino, degrau, início) — idempotência e remarcação; porta de escrita `fn_definir_lembrete_do_aviso_de_agendamento` (admin + suporte + MFA, revogada de anon/public). Espelho no fim do apêndice do `supabase/baseline.sql`.
-- ============================================================================
-- 9326 — O DONO É LEMBRADO ANTES DE CADA HORÁRIO, E O LINK VAI JUNTO.
--
-- O aviso de agendamento contava ao dono que um horário foi MARCADO, e o
-- resumo das 7h contava o dia. Nada o lembrava 1 hora antes de uma reunião
-- marcada pela IA dias atrás — e o link do Google Meet estava só no Google
-- Agenda. Esta migration dá ao lembrete do dono uma escolha própria e uma
-- entrega idempotente na MESMA tabela do aviso (mesmo número, mesmo anti-ban).
--
-- Idempotente: `add column if not exists`, `drop constraint if exists` + `add`,
-- índice `if not exists`, `create or replace function`. Nenhuma linha
-- existente viola as constraints novas: aviso e resumo nascem com as colunas
-- novas nulas, que é o que a forma exige deles.
-- ============================================================================

-- 1. A ESCOLHA DO DONO. Nasce desligada: quem já recebe o aviso de "marcado"
--    não passa a receber lembretes sem pedir (a mesma régua da 0194 para o
--    lembrete do cliente).
alter table public.config_aviso_de_agendamento
  add column if not exists lembrar_antes boolean not null default false;

comment on column public.config_aviso_de_agendamento.lembrar_antes is
  'Também lembra o número (e o grupo) do aviso ANTES de cada horário confirmado, nos degraus do tipo de atendimento com lembrete ligado, com o link da reunião. Motor em lib/agenda/lembrete-ao-dono.ts.';

-- 2. A ENTREGA DO LEMBRETE. Mesma tabela do aviso e do resumo: a tela de
--    "Últimos avisos" e a poda de retenção já a enxergam.
alter table public.entregas_de_aviso_de_agendamento
  add column if not exists degrau_minutos integer;
alter table public.entregas_de_aviso_de_agendamento
  add column if not exists inicio_lembrado timestamptz;

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_tipo_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_tipo_check
  check (tipo in ('aviso', 'resumo', 'lembrete'));

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_forma_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_forma_check
  check (
    (tipo = 'aviso' and event_id is not null and evento is not null and dia is null
       and degrau_minutos is null and inicio_lembrado is null)
    or (tipo = 'resumo' and dia is not null and event_id is null and appointment_id is null and evento is null
       and degrau_minutos is null and inicio_lembrado is null)
    or (tipo = 'lembrete' and appointment_id is not null and degrau_minutos is not null
       and inicio_lembrado is not null and event_id is null and evento is null and dia is null)
  );

alter table public.entregas_de_aviso_de_agendamento
  drop constraint if exists entregas_de_aviso_de_agendamento_degrau_check;
alter table public.entregas_de_aviso_de_agendamento
  add constraint entregas_de_aviso_de_agendamento_degrau_check
  check (degrau_minutos is null or degrau_minutos between 1 and 43200);

-- A CHAVE DA IDEMPOTÊNCIA DO LEMBRETE. O início entra na chave: remarcar dá à
-- data nova os próprios lembretes, e o mesmo degrau da mesma data nunca sai
-- duas vezes para o mesmo destino. O `23505` é o sinal que o motor lê para
-- reivindicar a entrega ANTES de tocar a rede.
create unique index if not exists entregas_de_aviso_de_agendamento_lembrete_unico
  on public.entregas_de_aviso_de_agendamento
     (organization_id, appointment_id, alvo, degrau_minutos, inicio_lembrado)
  where tipo = 'lembrete';

-- 3. A PORTA DE ESCRITA da escolha. Função própria, e não um parâmetro a mais
--    em `fn_definir_aviso_de_agendamento`: trocar a assinatura daquela exigiria
--    derrubar a porta que todo clone já usa. Mesmas guardas: admin da
--    organização, escrita de suporte permitida e MFA provado na sessão.
create or replace function public.fn_definir_lembrete_do_aviso_de_agendamento(
  p_org uuid,
  p_lembrar boolean
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes boolean;
begin
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_agendamento_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_agendamento_mfa_required' using errcode = '42501';
  end if;

  select lembrar_antes into v_antes
    from public.config_aviso_de_agendamento
   where organization_id = p_org
   for update;
  if not found then
    raise exception 'aviso_de_agendamento_sem_config' using errcode = '22023';
  end if;

  update public.config_aviso_de_agendamento
     set lembrar_antes  = coalesce(p_lembrar, false),
         atualizado_por = auth.uid(),
         updated_at     = now()
   where organization_id = p_org;

  return coalesce(v_antes, false);
end;
$$;
-- AS DUAS ORIGENS DE EXECUTE (item 9 da doutrina de migrations).
revoke all     on function public.fn_definir_lembrete_do_aviso_de_agendamento(uuid,boolean) from public, anon;
grant  execute on function public.fn_definir_lembrete_do_aviso_de_agendamento(uuid,boolean) to authenticated;

notify pgrst, 'reload schema';
