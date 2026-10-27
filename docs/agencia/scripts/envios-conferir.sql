-- O que a prova dos Envios deixou no banco e no Storage (rodar ANTES de limpar).
select titulo, tipo, versao, situacao, arquivo_bytes, arquivo_apagado_em is not null as apagado
  from agencia_aprovacoes where titulo like '%(prova)%' order by pedido_em;
select a.titulo, c.situacao, c.erro from agencia_envios_copias c join agencia_aprovacoes a on a.id = c.aprovacao_id where a.titulo like '%(prova)%';
select count(*) as objetos_no_bucket, coalesce(sum((metadata->>'size')::bigint), 0) as bytes from storage.objects where bucket_id = 'agencia-envios';
select action, count(*) from api_audit_log where action in ('agencia.aprovacao_pedida','agencia.aprovacao_cancelada','agencia.aprovacao_aprovada','agencia.aprovacao_ajustes','agencia.aviso_ciente') and created_at > now() - interval '1 hour' group by 1 order by 1;
