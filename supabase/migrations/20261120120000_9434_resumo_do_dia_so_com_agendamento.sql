-- manifest: **Resumo das 7h só quando houver agendamento (#4988):** `config_aviso_de_agendamento.resumo_so_com_agendamento` (nasce desligado — quem já recebe o resumo continua recebendo todo dia) e a porta de escrita `fn_definir_resumo_do_aviso_de_agendamento` (admin + suporte + MFA, revogada de anon/public). Os avisos de marcado/remarcado/cancelado e o lembrete antes do horário não mudam. Espelho no fim do apêndice do `supabase/baseline.sql`.
-- ============================================================================
-- 9434 — O RESUMO DAS 7H PODE FICAR QUIETO NO DIA SEM AGENDA.
--
-- Quem usa a agenda poucas vezes por semana recebia, na maioria dos dias, um
-- "Nenhum agendamento para hoje. Total: 0" — ruído ao lado dos outros avisos.
-- A única saída era desligar o aviso inteiro, e aí se perdia também o aviso de
-- cada horário marcado. Esta migration dá ao resumo uma escolha própria.
--
-- O motor (`lib/agenda/aviso-de-agendamento.ts`) decide ANTES de reivindicar a
-- entrega do dia: o dia vazio não grava linha em
-- `entregas_de_aviso_de_agendamento`, então "Últimos avisos" não ganha uma
-- linha por dia quieto, e nenhum CHECK de status precisa mudar.
--
-- Idempotente: `add column if not exists`, `create or replace function`.
-- ============================================================================

-- 1. A ESCOLHA DO DONO. Nasce desligada: quem já recebe o resumo todo dia não
--    deixa de recebê-lo sem pedir.
alter table public.config_aviso_de_agendamento
  add column if not exists resumo_so_com_agendamento boolean not null default false;

comment on column public.config_aviso_de_agendamento.resumo_so_com_agendamento is
  'O resumo das 7h só sai quando o dia tem agendamento ou houve mudança represada da madrugada. Não afeta os avisos de marcado/remarcado/cancelado nem o lembrete antes do horário. Motor em lib/agenda/aviso-de-agendamento.ts (aplicaResumoDoDia).';

-- 2. A PORTA DE ESCRITA da escolha. Função própria, como a do lembrete (9326):
--    trocar a assinatura de `fn_definir_aviso_de_agendamento` derrubaria a
--    porta que todo clone já usa. Mesmas guardas: admin da organização,
--    escrita de suporte permitida e MFA provado na sessão.
create or replace function public.fn_definir_resumo_do_aviso_de_agendamento(
  p_org uuid,
  p_so_com_agendamento boolean
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

  select resumo_so_com_agendamento into v_antes
    from public.config_aviso_de_agendamento
   where organization_id = p_org
   for update;
  if not found then
    raise exception 'aviso_de_agendamento_sem_config' using errcode = '22023';
  end if;

  update public.config_aviso_de_agendamento
     set resumo_so_com_agendamento = coalesce(p_so_com_agendamento, false),
         atualizado_por            = auth.uid(),
         updated_at                = now()
   where organization_id = p_org;

  return coalesce(v_antes, false);
end;
$$;
-- AS DUAS ORIGENS DE EXECUTE (item 9 da doutrina de migrations).
revoke all     on function public.fn_definir_resumo_do_aviso_de_agendamento(uuid,boolean) from public, anon;
grant  execute on function public.fn_definir_resumo_do_aviso_de_agendamento(uuid,boolean) to authenticated;

notify pgrst, 'reload schema';
