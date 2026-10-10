-- 0194 — o lembrete nascia LIGADO, e quem escolheu isso foi o default.
--
-- `calendar_event_types.reminder_enabled` nasceu `default true` na 0177. Medido hoje:
-- ZERO leitores fora do `database.types.ts` — a coluna e a `reminder_minutes_before`
-- irmã não são lidas por lib, app, workers, tests nem hooks —, e o `scheduler` do
-- compose não tem cron de lembrete nenhum. (Controle da mesma sonda: `event_type_id`
-- aparece em 9 arquivos, então o instrumento enxerga colunas desta entrega sendo lidas.)
--
-- ⚠️ E É JUSTAMENTE POR NÃO HAVER DISPARADOR QUE ISTO SE CONSERTA AGORA. O perigo não é
-- o envio de hoje — não há envio. É a ORDEM DOS EVENTOS: no dia em que alguém escrever o
-- disparador, ele lê esta coluna, e TODA linha criada antes daquele dia, em TODA instalação,
-- já estará marcada `true`. A chave chega PRÉ-LIGADA para o histórico inteiro, e ninguém
-- escolheu isso — o default escolheu, por ausência de decisão. Enviar mensagem a uma pessoa
-- é irreversível e nunca é operação comum: default que inscreve gente numa ação irreversível
-- é decisão de produto tomada pelo schema.
--
-- "Não há quem dispare" é razão para o defeito não ser URGENTE. Nunca é razão para ele não
-- ser DEFEITO — e aqui a ausência de disparador é o que torna a correção barata: uma palavra
-- agora, contra data migration sobre linhas que o operador já pode ter mexido depois.
--
-- Ligar lembrete por padrão fica com o dono do produto NO DIA em que o disparador nascer —
-- aí ele decide com o mecanismo na frente, e não com uma coluna que ninguém lê.
--
-- Forward-fix e não edição da 0177 pela mesma razão da 0193: ela vive em treze branches com
-- o baseline aplicado, e `create table if not exists` faz a reescrita virar no-op.

alter table public.calendar_event_types
  alter column reminder_enabled set default false;

-- As linhas JÁ criadas também voltam: com zero leitores e zero disparador, nada depende do
-- valor atual, então este é o único momento em que corrigir o histórico não regride
-- comportamento de ninguém. Depois do disparador, isto seria apagar a escolha de um operador.
update public.calendar_event_types
   set reminder_enabled = false
 where reminder_enabled is true;

comment on column public.calendar_event_types.reminder_enabled is
  'Lembrete automático deste tipo. Nasce DESLIGADO de propósito: enviar mensagem é irreversível, e um default ligado inscreveria o histórico inteiro sem ninguém ter escolhido. Ligar por padrão é decisão do dono do produto, a ser tomada quando o disparador existir.';
