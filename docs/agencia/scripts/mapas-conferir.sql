select m.titulo as mapa, b.especie, b.tipo, b.situacao, b.tarefa_id is not null as tarefa, b.envio_id is not null as envio, b.publicacao_id is not null as post
  from agencia_mapa_blocos b join agencia_mapas m on m.id = b.mapa_id where m.titulo = 'Mapa do Fluxo (prova)' order by b.criado_em;
select a.titulo, a.tipo, a.situacao from agencia_aprovacoes a where a.titulo = 'Gravação confirmada (prova)';
select p.titulo, p.formato, p.situacao from agencia_publicacoes p where p.titulo = 'Reels de dezembro (prova)';
select l.titulo, l.url from agencia_tarefas_links l join agencia_tarefas t on t.id = l.tarefa_id join agencia_mapa_blocos b on b.tarefa_id = t.id join agencia_mapas m on m.id = b.mapa_id where m.titulo = 'Mapa do Fluxo (prova)';
