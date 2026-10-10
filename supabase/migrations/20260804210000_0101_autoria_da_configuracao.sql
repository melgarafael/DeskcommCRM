-- 0101 — quem mexeu na CONFIGURAÇÃO da operação, ao lado do estado que mudou.
--
-- ⚠️ POR QUE AGORA. Até aqui, toda mudança em etapa de funil, entrada automática
-- de contatos e regra automática vinha de uma pessoa com papel `manager+` — quem
-- olhava a tela era, necessariamente, quem tinha mudado. Com o agente de IA
-- ganhando mãos sobre a operação (épico IA 360), o estado na tela deixa de
-- responder a pergunta que importa: FUI EU OU FOI ELE? Uma regra automática
-- ligada pelo assistente muda o comportamento do sistema quando ninguém está
-- olhando; sem esta coluna, a tela mostra "Ativa" e não diz mais nada.
--
-- O `api_audit_log` já registra tudo — e nenhuma tela de configuração o lê. Log
-- que não aparece é log morto (docs/doctrine/sistema-vivo.md, invariante 3). Por
-- isso a autoria mora na PRÓPRIA LINHA: o estado e a autoria do estado são lidos
-- na mesma consulta, pela tela que já existe.
--
-- ⚠️ NÃO HÁ COLUNA DE "QUAL AGENTE", E É DELIBERADO. `Actor.id` para `ai_agent`
-- ainda não é uma chave estável de agente nos três caminhos: o runtime nativo e
-- o harness mandam o id do AGENTE, mas `lib/mcp/auth.ts` `deriveActor()` devolve
-- o id do RUN (scope `agent_run:<uuid>`) ou o do TOKEN — o caminho de um cliente
-- MCP externo. Uma FK para `ai_agents(id)` alimentada daí seria verdadeira em
-- dois caminhos e recusaria a escrita com 23503 no terceiro. Guardar a ESPÉCIE
-- do ator é a afirmação que se sustenta nos três; o identificador cru continua
-- no audit log.
--
-- Idempotente e auto-curativa: colunas nullable, sem backfill necessário (linha
-- antiga fica com autoria desconhecida, que é a verdade sobre ela). O CHECK viaja
-- inline no `add column if not exists` — em banco que já tem a coluna, o comando
-- inteiro é no-op, que é o que o `update.sh` do clone precisa.

alter table public.crm_stages
  add column if not exists last_change_actor_kind text
  check (last_change_actor_kind in ('user','ai','system'));

alter table public.crm_stages
  add column if not exists last_change_at timestamptz;

alter table public.webhook_sources
  add column if not exists last_change_actor_kind text
  check (last_change_actor_kind in ('user','ai','system'));

alter table public.webhook_sources
  add column if not exists last_change_at timestamptz;

alter table public.automation_rules
  add column if not exists last_change_actor_kind text
  check (last_change_actor_kind in ('user','ai','system'));

alter table public.automation_rules
  add column if not exists last_change_at timestamptz;

comment on column public.crm_stages.last_change_actor_kind is
  'Espécie de quem fez a última mudança de configuração desta etapa: user | ai | system. NULL = anterior à 0101.';
comment on column public.webhook_sources.last_change_actor_kind is
  'Espécie de quem fez a última mudança nesta entrada automática de contatos: user | ai | system. NULL = anterior à 0101.';
comment on column public.automation_rules.last_change_actor_kind is
  'Espécie de quem ligou/desligou/editou esta regra por último: user | ai | system. NULL = anterior à 0101.';
