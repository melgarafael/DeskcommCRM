-- A regra de automação passa a poder guardar a CONFIGURAÇÃO DO GATILHO.
--
-- Até aqui toda regra nascia de um EVENTO, e o evento trazia tudo o que o motor
-- precisava: a entidade, o payload, o tipo. O gatilho novo (issue #989 —
-- "quando faltarem N dias para uma data do funil") não nasce de evento nenhum:
-- quem o emite é a varredura `app/api/v1/cron/lead-date-field-due`, e ela só
-- sabe onde olhar se a regra disser QUAL funil e QUAL campo de data, mais
-- quantos dias antes (ou depois) avisar.
--
-- ═══ POR QUE UMA COLUNA, E NÃO TABELA NOVA ═══
--
-- `automation_rules` já é a linha que o motor lê, a tela edita e a auditoria
-- nomeia. Uma tabela `automation_rule_trigger_configs` obrigaria a rota, o
-- motor e a tela a fazerem um join a mais para responder "o que esta regra
-- quer" — e deixaria dois lugares onde uma regra nasce pela metade.
--
-- ═══ POR QUE jsonb, E NÃO TRÊS COLUNAS ═══
--
-- O gatilho seguinte pode precisar de outra coisa (um par de horários, uma
-- janela). Três colunas específicas de um gatilho nascem como dívida na tabela
-- de todos: `pipeline_id` e `campo` vazios em 100% das regras dos outros nove
-- gatilhos. O jsonb é o mesmo desenho que `conditions` e `actions` já usam
-- nesta tabela, e o contrato de forma fica no TypeScript
-- (`lib/automation/gatilho-de-data-do-funil.ts::ConfigDoGatilhoDeData`), que é
-- quem valida na criação (schema da API) e na leitura (a varredura).
--
-- ═══ SEM CHECK, DE PROPÓSITO ═══
--
-- Validar o formato aqui exigiria recriar o CHECK a cada gatilho novo — e
-- `add constraint` não é idempotente. O que protege o banco é a porta única:
-- `createAutomationRuleSchema` recusa a regra de data sem a configuração dela,
-- e a varredura pula (com contagem em `pulados.config_invalida`) o que chegar
-- torto, sem derrubar as outras organizações.
--
-- ═══ O DEFAULT '{ }' NÃO É DECORAÇÃO ═══
--
-- `not null default '{}'` faz toda regra que já existe — e toda regra dos
-- outros gatilhos, que nunca escreve a coluna — nascer com o objeto vazio, sem
-- backfill e sem nada para decidir. Quem lê trata ausência e objeto vazio do
-- mesmo jeito (`configDoGatilhoDeData` devolve `null`), então a coluna não cria
-- uma terceira forma de "sem configuração".

alter table public.automation_rules
  add column if not exists trigger_config jsonb not null default '{}'::jsonb;

comment on column public.automation_rules.trigger_config is
  'Configuração do gatilho (issue #989). Vazio nos gatilhos que nascem de evento. No gatilho lead.date_field_due guarda {pipeline_id, campo, dias} — o campo de data pertence a UM funil, e sem essa dupla a varredura não sabe onde olhar.';

-- A rota da varredura SELECIONA esta coluna. O PostgREST só a enxerga depois de
-- recarregar o cache do schema; sem o aviso, o primeiro deploy que atualiza o
-- código vê `column automation_rules.trigger_config does not exist` até alguém
-- reiniciar o serviço à mão.
notify pgrst, 'reload schema';