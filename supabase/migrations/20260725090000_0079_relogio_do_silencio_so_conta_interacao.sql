-- 0079 — o relógio do silêncio para de ser zerado pela constatação do silêncio
--
-- O DEFEITO, medido antes de escrever: `fn_update_last_activity_at` carimba
-- `crm_leads.last_activity_at` para QUALQUER atividade, sem filtro de tipo. E
-- `last_activity_at` é exatamente o relógio que decide o esfriamento. Então o
-- produtor do estado apagaria o próprio estado ao registrá-lo: o negócio esfria,
-- o sistema registra "esfriou", o trigger zera o relógio, e o negócio volta a
-- "em dia" no mesmo instante. Vinte e quatro horas depois, de novo — uma linha
-- de timeline por janela, para sempre, sem ninguém ter feito nada.
--
-- Provado em transação revertida (lead 08b70b48, o mais frio com relógio
-- não-nulo): 484h de silêncio, bucket CRÍTICO → insere uma atividade → 0h,
-- bucket "em dia".
--
-- A regra geral: CONSTATAR O SILÊNCIO NÃO É QUEBRAR O SILÊNCIO. Toda métrica do
-- tipo "tempo desde o último X" é aniquilada por registrar observação sobre ela,
-- se o registro contar como X.
--
-- ⚠️ POR QUE LISTA POSITIVA E NÃO LISTA DE EXCEÇÕES — a assimetria é o ponto
-- inteiro, e inverter parece inofensivo:
--
--   com lista de exceções ("ignore lead_cooled"), um tipo NOVO de observação de
--   sistema, daqui a seis meses, volta a carimbar o relógio. O negócio parece
--   vivo estando morto: morte silenciosa, que é a doença que esta wave existe
--   para curar;
--
--   com lista positiva, um tipo novo de interação REAL fica de fora e o negócio
--   parece frio estando quente: alarme falso, visível, alguém reclama e conserta.
--
-- O default para o que ainda não existe tem de ser o erro BARULHENTO.
--
-- AS ESCOLHAS DE FORA, cada uma com sua razão — revisáveis, mas não por
-- distração:
--   send_vetoed        o envio não chegou ao cliente. Se contasse, um negócio em
--                      que a IA tenta e é barrada em looping pareceria vivo
--                      estando travado;
--   handoff_triggered  passar para humano é PROMESSA de atendimento, não
--                      atendimento. Se contasse, o negócio transferido e nunca
--                      atendido ficaria mascarado justamente na janela em que
--                      alguém deveria notar;
--   next_action_dismissed  o humano decidiu NÃO agir. O negócio fica sem próximo
--                      passo, que é a definição de risco na doutrina — deveria
--                      esfriar mais rápido, não menos.

create or replace function public.fn_update_last_activity_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  -- LISTA POSITIVA: só isto conta como "alguém tocou este negócio". Tipo que
  -- não está aqui NÃO quebra o silêncio — inclusive tipo que ainda não existe.
  -- Ver o cabeçalho da 0079 antes de acrescentar linha nesta lista.
  if new.type not in (
    'ai_turn',              -- a IA falou com o cliente
    'note',                 -- alguém registrou trabalho no negócio
    'lead_edited',          -- humano mexeu nos dados
    'stage_changed',        -- humano moveu o negócio
    'next_action_approved'  -- humano decidiu agir
  ) then
    return new;
  end if;

  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$function$;

comment on function public.fn_update_last_activity_at() is
  'Carimba last_activity_at SÓ para tipos que contam como interação (lista positiva — ver migration 0079). Constatar o silêncio não é quebrar o silêncio: sem este filtro, a atividade que registra "este negócio esfriou" zera o próprio relógio que produziu o estado.';
