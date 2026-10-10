-- ============================================================================
-- 0187 — ESPELHO DECLARADO SEM PRAZO VIRA ARQUIVO PERMANENTE COM OUTRO NOME
--
-- A 0184 deixou `calendar_external_events` FORA da cascata de LGPD, e a razão
-- está escrita lá: a tabela não tem `contact_id`, e o único vínculo com a pessoa
-- é o `title` copiado do Google. Não há predicado que a alcance a partir do
-- contato anonimizado, e apagar por conexão destruiria dado de terceiros que não
-- pediram nada.
--
-- A decisão de produto foi declarar ESPELHO: a fonte da verdade daquele dado é a
-- agenda do Google do próprio cliente, onde o titular exerce o direito com o
-- controlador de lá. Mas uma declaração dessas só é honesta com TRÊS
-- propriedades, e a terceira é a que faltava:
--
--   1. é reconstruível — o sync repõe o que for apagado;
--   2. some quando a conexão sai — já verdade: `connection_id` é
--      `on delete cascade` desde a 0177;
--   3. TEM PRAZO. Sem isto, "espelho" é só um nome mais simpático para um
--      arquivo permanente de compromissos de terceiros, guardado por um produto
--      que declarou não ser o controlador daquele dado.
--
-- Esta migration entrega a terceira.
--
-- ─── O que se apaga, e o que NUNCA se apaga ──────────────────────────────
-- Só o PASSADO. O corte é `ends_at < now() - N dias`: um compromisso futuro não
-- envelhece, por mais antigo que seja o registro dele. Apagar pelo `created_at`
-- — que é o que a poda de audit faz — removeria um evento marcado com um ano de
-- antecedência antes de ele acontecer, e a agenda passaria a marcar em cima dele.
--
-- ─── Piso, e por que ele é baixo aqui ────────────────────────────────────
-- O piso é 7 dias, o mesmo de `RETENCAO_FILA_DIAS_PISO`, e não os 90 da
-- auditoria. Auditoria é rastro que existe para ser consultado depois de um
-- incidente, e um piso alto impede que o knob vire apagador de rastro. Este
-- espelho é cache: quem quiser um passado mais longo pede ao sync, que repõe.
-- Piso alto aqui não protege ninguém — só guarda mais tempo dado de terceiro.
--
-- Aditiva: função nova. Nenhuma linha é apagada pela aplicação da migration —
-- quem apaga é o cron, em lotes, quando chamado.
-- ============================================================================

create or replace function public.fn_expurgar_espelho_da_agenda(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 90 dias de passado visível; piso de 7 porque isto é cache reconstruível pelo
  -- sync, e não rastro que precise sobreviver a um incidente.
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 7);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidos as (
    select e.id
      from public.calendar_external_events e
     -- `ends_at` e não `created_at`: um compromisso futuro não envelhece, e
     -- apagá-lo faria a agenda marcar em cima de hora ocupada.
     where e.ends_at < now() - make_interval(days => v_dias)
     order by e.ends_at
     limit v_limite
  )
  delete from public.calendar_external_events e
   using vencidos v
   where e.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

revoke execute on function public.fn_expurgar_espelho_da_agenda(int, int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_espelho_da_agenda(int, int) to service_role;

comment on table public.calendar_external_events is
  'ESPELHO, somente-leitura, do que já existe na agenda conectada. Ocupa horário e aparece na grade, mas NÃO é compromisso nosso: não tem lead, não tem estado de atendimento e nunca é reescrito por nós. É CACHE — reconstruível pelo sync, apagado em cascata quando a conexão sai, e com prazo (fn_expurgar_espelho_da_agenda, migration 0187). Fica FORA da cascata de LGPD por não ter contact_id: o único vínculo com a pessoa é o title copiado do Google, e a fonte da verdade daquele dado é a agenda do próprio cliente, onde o titular exerce o direito com o controlador de lá. A mira de verdade só nasce com o escritor do sync, que terá o ical_uid para ligar — decisão de QUANDO, não de SE.';

create index if not exists calendar_external_events_poda_idx
  on public.calendar_external_events (ends_at);

notify pgrst, 'reload schema';
