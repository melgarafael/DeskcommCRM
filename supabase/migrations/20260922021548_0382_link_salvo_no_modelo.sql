-- O LINK DA MÍDIA FICA SALVO NO MODELO.
--
-- Modelo com cabeçalho de imagem, vídeo ou documento exige o link da mídia em
-- TODO disparo: o que a plataforma guarda na aprovação é só a amostra. Sem um
-- lugar para guardar o link, o operador colava a mesma URL toda vez que a
-- janela de 24h fechava — e um link errado uma vez era um envio perdido.
--
-- `meta_templates.saved_values` guarda, por modelo, os valores que o operador
-- decidiu reaproveitar. A chave é a MESMA de `template_values` no envio
-- (`slotKey`: `header:1`, `button0:1`…), então o painel pré-preenche o campo
-- sem tradução nenhuma.
--
-- ## Por que uma coluna nesta tabela, e não uma tabela nova
--
-- O valor salvo pertence à definição (nome + idioma + número), e a linha do
-- espelho já é exatamente isso. A sincronização (`syncTemplates`) faz `upsert`
-- listando as colunas que vêm da plataforma; coluna fora da lista sobrevive ao
-- sync, que é o que precisamos: sincronizar não pode apagar o link salvo.
--
-- ## O que NÃO se guarda aqui
--
-- Só link de mídia, e a rota de escrita recusa o resto. Valor de `{{1}}` no
-- corpo costuma ser o nome do cliente: salvar isso no modelo mandaria o nome de
-- uma pessoa para a próxima.
--
-- Default `{}` e `not null`: toda linha existente fica sem link salvo, que é o
-- comportamento de hoje. CHECK garante objeto — um array ou texto ali faria o
-- painel ler lixo como valor.
--
-- Aditiva, sem backfill, sem função nova, sem policy nova (a tabela segue
-- sendo escrita só pelo servidor). Apêndice no baseline antes da varredura
-- anon, idempotente.

alter table public.meta_templates
  add column if not exists saved_values jsonb not null default '{}'::jsonb;

alter table public.meta_templates
  drop constraint if exists meta_templates_saved_values_objeto;
alter table public.meta_templates
  add constraint meta_templates_saved_values_objeto
  check (jsonb_typeof(saved_values) = 'object');

comment on column public.meta_templates.saved_values is
  'Valores que o operador salvou para reaproveitar em todo disparo deste modelo, chaveados como template_values (slotKey: header:1, button0:1). Só link de mídia: a rota de escrita recusa valor de texto, que costuma ser dado de pessoa. Sobrevive à sincronização, que não lista esta coluna no upsert.';
