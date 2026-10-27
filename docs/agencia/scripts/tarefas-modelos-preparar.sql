with f as (insert into agencia_funcoes (nome, permissoes, ativa) values ('Tarefas (prova)', array['tarefas.criar','tarefas.ver_todas'], true) returning id)
insert into agencia_membros_funcoes (membro_id, funcao_id) select 'f49cbbe8-933c-4164-91fb-dbac2b18a791', id from f;
