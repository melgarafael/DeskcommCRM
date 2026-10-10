-- 0112 — as ferramentas do papel OPERADOR (spec 16 §6, regra de tela 1).
--
-- Coluna PRÓPRIA, e não reuso de `tool_ids`, por três razões que se somam:
--
--   1. **A tela não pode mentir.** Se os dois papéis lessem a mesma lista, a
--      seção "Operador" estaria configurando o que o Conversador executa — e o
--      usuário aprenderia um modelo mental que o motor não implementa.
--   2. **O teto de 20 deixa de ser um problema por divisão, não por aumento.**
--      Hoje o Conversador carrega até 12 nativas + 20 de catálogo = 32 num
--      prompt só, e o e2e `capacidades-do-agente` está fora do CI porque ligar
--      "Atender" estoura o teto. Com listas separadas, cada papel tem o seu
--      orçamento e nenhum deles precisa crescer.
--   3. **O passo 6 vira uma migration de DADOS, não de schema.** Tirar as
--      ferramentas de escrita do Conversador passa a ser mover ids de uma coluna
--      para a outra, com rollback trivial.
--
-- Default `'{}'`: o papel nasce sem mão nenhuma. Ligado + sem ferramenta é um
-- estado legítimo e observável (ele ainda registra promessa em aberto), e é
-- melhor do que herdar silenciosamente as do Conversador — herança implícita
-- faria o humano ligar o papel e dar 20 capacidades sem ter escolhido nenhuma.
alter table ai_agent_versions
  add column if not exists operator_tool_ids text[] not null default '{}'::text[];

comment on column ai_agent_versions.operator_tool_ids is
  'Spec 16 §6: capacidades do papel Operador, independentes de `tool_ids` (do '
  'Conversador). Vazio = o papel roda mas não tem mão — estado legítimo: ele '
  'ainda registra promessa em aberto na Central.';
