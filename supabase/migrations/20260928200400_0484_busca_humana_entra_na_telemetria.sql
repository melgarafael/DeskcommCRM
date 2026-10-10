-- 0484 — a busca HUMANA do acervo entra na telemetria (F2 da issue #1869)
--
-- ## O buraco (medido na base 83f10c3e5)
--
-- `knowledge_searches` só era preenchida por UM caminho: `search-knowledge.ts:122`,
-- o turno do agente. A capacidade MCP `crm_search_knowledge` promoveu a *capacidade*
-- à primeira classe — o docblock dela diz literalmente "PROMOÇÃO DE CAPACIDADE
-- SOMBRA: o humano não a via, não a desligava e não auditava" — mas o uso HUMANO
-- continuou fora da métrica. O gráfico de `/app/ai/evolution` contava só a IA
-- perguntando, e a tela "Perguntar ao acervo" (F1 da mesma issue) passaria a
-- perguntar sem deixar rastro nenhum.
--
-- ## Por que coluna e não `agent_id is null`
--
-- Parece o atalho óbvio e é uma armadilha: `agent_id` é `on delete set null`
-- desde a 0181, então ele fica NULL também quando um agente é apagado depois de
-- ter perguntado. NULL não distingue "foi o operador" de "o agente sumiu" — e a
-- segunda hipótese é exatamente o caso em que a métrica precisa continuar
-- atribuindo a busca à IA. Coluna própria diz o fato, não deduz de ausência.
--
-- ## Vocabulário
--
-- Segue a 0281 (`author_kind text not null check (author_kind in ('human','ai'))`
-- em `agent_case_chat_messages`), que é a última vez em que a casa resolveu
-- "quem perguntou" nesta codebase. Mantém-se `('human','ai')` — e não o
-- `('user','ai')` do `owner_kind` (0070), que nomeia o DONO de um registro, não
-- o AUTOR de uma pergunta. Dois vocabularios para o mesmo fato é o anti-pattern
-- de duplicação que o CLAUDE.md já proíbe.
--
-- ## Backfill
--
-- Nenhum `update` necessário: `default 'ai'` cobre as linhas existentes porque
-- TODAS vieram do agente — é essa a verdade histórica. A 0070 precisou de
-- backfill manual porque o default dela era null e a coluna que indicava o dono
-- já existia antes; aqui a coluna nasce junto com o default certo.
--
-- ## `author_user_id`
--
-- `on delete set null`: a saída de uma pessoa do sistema não apaga o que ela
-- perguntou — mesma decisão da 0281, e pelo mesmo motivo NÃO existe check
-- acoplando `author_kind` a `author_user_id`: ele quebraria o próprio `set null`
-- (a constraint passaria a exigir 'human' numa linha cujo usuário acabou de ser
-- apagado, e a telemetria de ontem viraria erro de hoje).
--
-- ## O que isto NÃO faz
--
-- Não muda o INSERT do agente: ele já grava sem esta coluna e o `default`
-- responde por ele. Importante, porque `search-knowledge.test.ts:127` mede as
-- posições $1..$8 do insert ("parâmetro novo entra no FIM") — mexer na ordem
-- deixaria aquela guarda vermelha por um motivo que não é o dela.
-- Não guarda o texto da pergunta: a decisão da 0086 (sem PII em telemetria de
-- retenção longa) continua valendo.

alter table public.knowledge_searches
  add column if not exists author_kind text not null default 'ai'
  check (author_kind in ('human', 'ai'));

alter table public.knowledge_searches
  add column if not exists author_user_id uuid
  references auth.users(id) on delete set null;

comment on column public.knowledge_searches.author_kind is
  'Quem perguntou: ''ai'' = turno do agente ou a ferramenta MCP crm_search_knowledge; ''human'' = o operador na tela "Perguntar ao acervo" (F1 da #1869). Vocabulário da 0281.';

comment on column public.knowledge_searches.author_user_id is
  'Operador que perguntou no caminho humano. null no caminho do agente, e também quando a pessoa sai do sistema — on delete set null preserva a pergunta, por isso não há check acoplando esta coluna à author_kind.';

notify pgrst, 'reload schema';
