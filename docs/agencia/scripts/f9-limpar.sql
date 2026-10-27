delete from agencia_publicacoes where cliente_id = '8a49b809-3320-40d0-8e18-c3be9b53f0c8' and criado_por = '8e2cd8b3-1064-498b-ba83-5476b980dcf0' and situacao = 'rascunho' and criado_em > now() - interval '1 day';
delete from agencia_tarefas where titulo like '%(prova)';
delete from agencia_tarefas where id in (select tarefa_id from agencia_mapa_blocos b join agencia_mapas m on m.id = b.mapa_id where m.titulo like '%(prova)');
delete from agencia_mapas where titulo like '%(prova)';
delete from agencia_membros_funcoes where funcao_id in (select id from agencia_funcoes where nome = 'IA (prova F9)');
delete from agencia_funcoes where nome = 'IA (prova F9)';
