-- Prova do arrastar/esticar: função temporária, uma reunião interna (sem avisar o cliente)
-- e dois posts da Empresa Modelo. Desfazer com calendario-limpar.sql.
with f as (insert into agencia_funcoes (nome, permissoes, ativa) values ('Calendário (prova)', array['calendario.gerenciar','publicacoes.gerenciar','tarefas.criar'], true) returning id)
insert into agencia_membros_funcoes (membro_id, funcao_id) select 'f49cbbe8-933c-4164-91fb-dbac2b18a791', id from f;
with r as (
  insert into agencia_reunioes (tipo, titulo, cliente_id, inicio, fim, formato, avisar_cliente)
  values ('interna', 'Reunião de pauta (prova)', '8a49b809-3320-40d0-8e18-c3be9b53f0c8',
          '2026-11-10 10:00-03', '2026-11-10 11:00-03', 'online', false)
  returning id)
insert into agencia_reunioes_membros (reuniao_id, membro_id) select id, 'f49cbbe8-933c-4164-91fb-dbac2b18a791' from r;
insert into agencia_publicacoes (cliente_id, titulo, rede, formato, quando, situacao) values
  ('8a49b809-3320-40d0-8e18-c3be9b53f0c8', 'Post rascunho (prova)', 'instagram', 'feed', '2026-11-12 18:00-03', 'rascunho'),
  ('8a49b809-3320-40d0-8e18-c3be9b53f0c8', 'Post agendado (prova)', 'instagram', 'feed', '2026-11-13 09:00-03', 'agendada');
