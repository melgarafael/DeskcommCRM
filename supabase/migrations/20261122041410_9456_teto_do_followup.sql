-- manifest: **O follow-up tem teto diário próprio, separado do teto de abordagem (#4063, refs #3851).** A opção `channel_knobs.teto_so_abordagem` tira o teto de abordagem do follow-up de quem já foi abordado — era o pedido —, mas não punha nada no lugar: com a chave ligada, 200, 300, 400 follow-ups no mesmo dia saíam todos (medido: 380 num dia, zero vetos), porque a única régua que os media era a que a opção desliga. `channel_knobs.followup_daily_cap` (inteiro positivo; NULL = o default de `lib/agent-engine/pacing/defaults.ts`, **200**/dia) é o teto de SEGURANÇA do volume já em conversa: `decidePacing` conta os disparos do dia que não são abordagem nem resposta (`sentToday - abordagensToday`, a mesma conta que o estado já traz) e veta com código próprio `followup_cap` quando eles chegam ao teto. Só arma com a opção ligada e `abordagem: false`; desligada, o follow-up segue contando no teto de sempre, byte a byte. O valor mora no mesmo lugar dos outros limites (os knobs do canal) e é lido pelo mesmo `loadChannelKnobs`. Idempotente; espelho no apêndice do `baseline.sql`.
-- 9456 — teto diário próprio do follow-up (segurança do volume já em conversa, #4063).
--
-- Uma coluna, nenhuma função: não há grant a revogar nem SECURITY DEFINER novo,
-- então este bloco pode ficar depois da VARREDURA anon no apêndice do baseline.
--
-- `followup_daily_cap` nasce NULL (não 200) de propósito: NULL é "o canal não
-- escolheu", e é o default do motor (`PACING_DEFAULTS.followupDailyCap`) que
-- responde. Gravar 200 aqui congelaria o número de hoje em toda linha existente —
-- e mudá-lo depois exigiria um backfill para acompanhar a mudança do default.
-- Mesmo raciocínio que fez `teto_so_abordagem` nascer NULL.
alter table public.channel_knobs
  add column if not exists followup_daily_cap integer;
comment on column public.channel_knobs.followup_daily_cap is
  'Teto diário PRÓPRIO do follow-up (disparo que não é abordagem nem resposta), separado do teto de abordagem. Só arma com teto_so_abordagem ligado; desligado, o follow-up conta no teto de sempre. NULL = default do motor (200/dia). Inteiro > 0; valor inválido cai no default com warn (#4063, refs #3851).';

-- A coluna é nula por padrão em toda linha existente; nenhum backfill é preciso.
-- O CHECK fica no próprio add column para o banco recusar lixo na origem (a leitura
-- em `loadChannelKnobs` também valida — defesa em profundidade, como o warm-up).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'channel_knobs_followup_daily_cap_check'
       and conrelid = 'public.channel_knobs'::regclass
  ) then
    alter table public.channel_knobs
      add constraint channel_knobs_followup_daily_cap_check
      check (followup_daily_cap is null or followup_daily_cap > 0);
  end if;
end $$;
