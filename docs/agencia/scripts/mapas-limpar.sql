delete from agencia_tarefas where id in (select b.tarefa_id from agencia_mapa_blocos b join agencia_mapas m on m.id = b.mapa_id where m.titulo in ('Mapa do Fluxo (prova)', 'Ciclo de dezembro (prova)'));
delete from agencia_aprovacoes where titulo = 'Gravação confirmada (prova)';
delete from agencia_publicacoes where titulo = 'Reels de dezembro (prova)';
delete from agencia_mapas where titulo in ('Mapa do Fluxo (prova)', 'Ciclo de dezembro (prova)');
delete from user_organizations where user_id = '8e2cd8b3-1064-498b-ba83-5476b980dcf0' and organization_id = 'ca2e3ea3-3d5d-4c9d-b421-4da37073051a';
delete from agencia_membros_funcoes where funcao_id in (select id from agencia_funcoes where nome = 'Mapas (prova)');
delete from agencia_funcoes where nome = 'Mapas (prova)';
