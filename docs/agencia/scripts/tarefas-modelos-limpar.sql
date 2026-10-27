delete from agencia_tarefas where titulo = 'Gravação de dezembro (prova)';
delete from agencia_membros_funcoes where funcao_id in (select id from agencia_funcoes where nome = 'Tarefas (prova)');
delete from agencia_funcoes where nome = 'Tarefas (prova)';
