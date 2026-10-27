select titulo, to_char(inicio at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as inicio, to_char(fim at time zone 'America/Sao_Paulo', 'HH24:MI') as fim, situacao
  from agencia_reunioes where titulo = 'Reunião de pauta (prova)';
select titulo, to_char(quando at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as quando, situacao from agencia_publicacoes where titulo like '%(prova)%' order by titulo;
select action, count(*) from api_audit_log where action in ('agencia.reuniao_alterada','agencia.publicacao_salva') and created_at > now() - interval '30 minutes' group by 1;
