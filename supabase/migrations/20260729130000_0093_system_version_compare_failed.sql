-- 0093 — "não consegui comparar" deixa de virar "você está em dia".
--
-- O agente do host resolve a última versão publicada e compara com a instalada.
-- Quando ele NÃO consegue comparar (o install.sh clona com --depth 1, e sem
-- conseguir completar a história o git não sabe dizer o que é mais novo), ele
-- deixa de anunciar a tag — e a tela lia essa ausência como "não há nada
-- novo", dizendo "é a mais recente" para uma instalação possivelmente atrasada.
-- Silêncio virando boa notícia é o pior modo de falha desta feature: o cliente
-- deixa de receber correção de segurança sem nunca saber.
--
-- Uma coluna, não um estado novo: a máquina de estados do run continua a mesma.
alter table public.system_version
  add column if not exists compare_failed boolean not null default false;

comment on column public.system_version.compare_failed is
  'true quando o agente do host não conseguiu comparar a versão instalada com a última publicada (ex.: clone raso sem conseguir completar a história). A tela mostra "não consegui checar", nunca "você está em dia".';
