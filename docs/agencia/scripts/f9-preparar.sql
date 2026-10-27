-- Prova da Fase 9: função temporária (mapa.editar, tarefas.criar, tarefas.atribuir) e uma tarefa da Empresa Modelo
-- com o membro de teste de responsável.
with f as (insert into agencia_funcoes (nome, permissoes, ativa) values ('IA (prova F9)', array['mapa.editar','tarefas.criar','tarefas.atribuir'], true) returning id)
insert into agencia_membros_funcoes (membro_id, funcao_id) select 'f49cbbe8-933c-4164-91fb-dbac2b18a791', id from f;
with t as (
  insert into agencia_tarefas (titulo, descricao, cliente_id, coluna, posicao)
  values ('Legenda do Reels de dezembro (prova)', 'Reels mostrando a vitrine nova de Natal; promoção de 15% até 24/12.', '8a49b809-3320-40d0-8e18-c3be9b53f0c8', 'a_fazer', 999999)
  returning id)
insert into agencia_tarefas_responsaveis (tarefa_id, membro_id) select id, 'f49cbbe8-933c-4164-91fb-dbac2b18a791' from t returning tarefa_id;
