-- 0150 — o espelho de definições passa a saber de QUAL conexão cada uma é.
--
-- ─── O que estava impossível ───────────────────────────────────────────────
--
-- `meta_templates` nasceu para um canal só, e a única coisa que identifica a
-- origem de uma linha é `waba_id` — que é o id da conta na plataforma da Meta.
-- Um segundo canal, que tem definições próprias e uma conta com id de outro
-- formato, não tem onde entrar sem mentir sobre o que aquele campo significa.
--
-- O efeito prático, medido: a tela de definições e o endpoint que a alimenta
-- resolvem a sessão pela função `metaSessionForOrg`. Numa instalação com o
-- canal intermediado e SEM o oficial, o endpoint devolve lista vazia — e o
-- operador conclui que não tem nenhuma definição aprovada quando tem várias.
--
-- ─── Por que a conexão, e não um campo `provider` ──────────────────────────
--
-- Porque a pergunta que a tela faz é "quais definições posso usar NESTA
-- conexão?", e não "quais são deste tipo de canal". Duas conexões do mesmo
-- provider (dois números) têm definições diferentes, e um `provider text`
-- responderia as duas com a mesma lista.
--
-- É a doutrina DIRC: **R**eferenciar. A conexão já existe em
-- `channel_sessions`; aqui basta o ponteiro.
--
-- ─── Nulo é estado legítimo, não pendência ────────────────────────────────
--
-- As linhas que já existem vieram do canal oficial e não têm sessão registrada.
-- Deixá-las nulas é honesto (ninguém sabe de qual sessão são) e não quebra
-- nada: quem lê filtra por sessão OU aceita a coluna nula, e o `waba_id`
-- continua sendo a chave de unicidade que sempre foi.
--
-- `on delete set null`, não `cascade`: apagar uma conexão não pode levar junto
-- o registro do que a plataforma aprovou. A definição continua existindo lá,
-- e quem reconectar depois quer encontrá-la — sumir com a linha faria o CRM
-- dizer "não tem nenhuma" sobre uma conta cheia delas.
--
-- Aditiva e idempotente.

alter table public.meta_templates
  add column if not exists channel_session_id uuid
    references public.channel_sessions(id) on delete set null;

comment on column public.meta_templates.channel_session_id is
  'A conexão de onde esta definição veio. NULL = origem não registrada (linhas anteriores à 0144, todas do canal oficial). A tela filtra por aqui para responder "o que posso usar NESTA conexão?" — dois números do mesmo provider têm definições diferentes.';

create index if not exists meta_templates_sessao_idx
  on public.meta_templates (channel_session_id, status)
  where channel_session_id is not null;
