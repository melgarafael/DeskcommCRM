delete from agencia_reunioes where titulo = 'Reunião de pauta (prova)';
delete from agencia_publicacoes where titulo in ('Post rascunho (prova)', 'Post agendado (prova)');
delete from agencia_membros_funcoes where funcao_id in (select id from agencia_funcoes where nome = 'Calendário (prova)');
delete from agencia_funcoes where nome = 'Calendário (prova)';
