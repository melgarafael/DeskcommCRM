-- 0238 · Fluxo de atendimento: tentativas por pergunta.
--
-- Uma pergunta feita e não respondida não pode ser repetida para sempre. O
-- fluxo define um teto (`settings.max_tentativas_pergunta`); cada vez que a
-- pergunta é feita sem resposta, `attempts` sobe. Ao atingir o teto, a pergunta
-- é considerada ENCERRADA (não respondida) e deixa de ser feita — e não bloqueia
-- mais a conclusão do fluxo.
--
-- Aditiva e idempotente: coluna com default; nenhuma constraint/função nova.

alter table public.contact_flow_data
  add column if not exists attempts smallint not null default 0;

comment on column public.contact_flow_data.attempts is
  'Quantas vezes a pergunta foi feita sem resposta. Ao atingir max_tentativas_pergunta (settings do grafo), a pergunta é encerrada como não respondida e deixa de ser feita.';

comment on column public.contact_flow_data.value is
  'Valor CRU informado pelo cliente (como ele escreveu). O normalizado fica em value_json e é o que o sistema usa.';

notify pgrst, 'reload schema';
