-- Atualizar o CRM deixa de desligar os lembretes que o operador ligou.
--
-- ═══ O DEFEITO, E POR QUE ELE É INVISÍVEL ═══
--
-- A 0194 pôs `reminder_enabled` em `default false` e, junto, corrigiu o
-- histórico:
--
--     update public.calendar_event_types
--        set reminder_enabled = false
--      where reminder_enabled is true;
--
-- O raciocínio dela está escrito ao lado e era correto NAQUELE dia: "com zero
-- leitores e zero disparador, nada depende do valor atual". O próprio comentário
-- antecipa o que aconteceria depois — *"Depois do disparador, isto seria apagar
-- a escolha de um operador"*.
--
-- O disparador nasceu (o cron `agenda-reminder`), e o `update.sh` **re-aplica o
-- baseline inteiro a cada atualização**. Então a frase de aviso virou o
-- comportamento: toda atualização desliga o lembrete de todo tipo em que alguém
-- o ligou.
--
-- E não dá sinal nenhum. Nada falha, nada aparece no log, a tela mostra o
-- controle desmarcado como se ninguém o tivesse marcado. Descobre-se pelo
-- cliente que não recebeu o aviso — ou não se descobre.
--
-- ═══ A GUARDA, E POR QUE ELA É O CATÁLOGO ═══
--
-- Pelo VALOR da coluna é impossível distinguir "linha antiga que ninguém
-- escolheu" de "linha que o operador acabou de ligar": as duas são `true`.
--
-- O que distingue é o `column_default`. Ele só é diferente de `false` **antes**
-- da primeira aplicação da 0194 neste banco — que é exatamente o único momento
-- em que corrigir o histórico é certo. Da segunda vez em diante o default já é
-- `false`, e aí `true` só pode ter vindo de alguém escolhendo.
--
-- ⚠️ A ORDEM IMPORTA: ler o default ANTES de gravá-lo. Invertido, a condição
-- seria sempre falsa e um clone pré-0194 nunca receberia a correção do histórico
-- que a 0194 existe para fazer.
--
-- Clone que já atualizou alguma vez: não muda nada (o default já é `false`, e o
-- update não roda). Clone pré-0194: recebe a correção, uma vez, como sempre
-- recebeu.

do $$
declare
  v_default text;
begin
  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'calendar_event_types'
     and column_name = 'reminder_enabled';

  -- `is distinct from` e não `<>`: num banco onde a coluna ainda não existe a
  -- consulta devolve NULL, e `NULL <> 'false'` seria NULL — nem verdadeiro nem
  -- falso —, pulando a correção em silêncio.
  if v_default is distinct from 'false' then
    update public.calendar_event_types
       set reminder_enabled = false
     where reminder_enabled is true;
  end if;
end $$;

alter table public.calendar_event_types
  alter column reminder_enabled set default false;

comment on column public.calendar_event_types.reminder_enabled is
  'Lembrete automático deste tipo. Nasce DESLIGADO: enviar mensagem é irreversível. O histórico foi corrigido UMA vez, na primeira aplicação da 0194 em cada banco (a 0255 guarda isso pelo column_default) — depois disso, true significa que alguém ligou, e atualizar o CRM não desliga mais.';
