# Sessão nativa ativa no REST

Este candidato acrescenta revogação de sessão na entrada do PostgREST. O logout nativo revoga refresh tokens; access JWT pode continuar válido até expirar. O controle adicional consulta auth.sessions por session_id/sub para cada requisição authenticated. Não é invalidação criptográfica do JWT e não se aplica ao WebSocket/Reatime ou a outro consumidor de JWT.

## Contrato

- O PostgREST continua responsável por assinatura, papel e claims temporais. A guarda não confia em headers de cliente para declarar service_role.
- anon mantém acesso RLS/GRANT de antes, sem consulta a auth.sessions. service_role mantém seu contrato servidor e não exige session_id. Ambos continuam sujeitos ao replay409.
- authenticated exige UUIDs session_id/sub, exp JSON numérico ainda futuro e linha nativa com mesmo id/user_id e not_after não vencido. Ausência/encerramento resulta401 antes da query.
- Tokens de terceiro/legados sem session_id deixam de acessar REST como authenticated. Precisam migrar para sessão GoTrue ou receber decisão explícita de compatibilidade antes de publicar. Não criar exceção baseada só em claims controláveis pelo cliente.
- Sessões expiram conforme not_after; inatividade/single-session enforcement além do estado nativo não foi reimplementada. Requisição já em curso conserva seu snapshot; revogação é observada na próxima requisição. Falha de acesso à tabela é fail-closed, não tratada como sessão válida.

## Integração

O hook novo público é invoker e chama primeiro fn_pgrst_recusar_replay_do_gateway, sem alterar o corpo anterior. O lookup é definer em schema não exposto, sem SQL dinâmico, search_path vazio e EXECUTE restrito aos três papéis. Nenhuma RLS/grant de tabela é ampliada. Requer privilégio SELECT do dono da função em auth.sessions; deve ser conferido no runtime alvo.

A migration registra o hook com ALTER ROLE authenticator IN DATABASE (banco corrente), sem mudar o papel global. Se um hook desconhecido já existir, recusa a composição em vez de apagá-lo. Aplique transactionalmente. PostgREST com db-config=false não lê o registro: precisa configuração explícita correspondente. O número9110 é reserva LOCAL do candidatob978, não validado contra upstream/PRs em tempo real.

## Custo e rollback

Uma consulta por chave primária auth.sessions por requisição authenticated; nenhum cache positivo que sobreviva ao logout. Não substitui RLS multi-tenant. Custo/p95 sob carga e integração fresh/update do baseline inteiro são gates distintos.

Rollback operacional: restaurar apenas o db_pre_request específico deste banco para public.fn_pgrst_recusar_replay_do_gateway e NOTIFY pgrst reload config; deixa objetos e dados preservados. Não remover RLS, auth.sessions nem roles. Verificar200 para sessão válida e409 para replay após reversão.

## Verificação

Matriz HTTP isolada: ativo200, sessão ausente/expirada/outro usuário401, authenticated sem SID/sub/exp ou com UUID inválido401; anon/service200; replay antigo409 para todos; assinatura inválida/JWT expirado401 nativos; checker privado não exposto por RPC/profile; sabotagem do checker faz o controle negativo voltar200, reapply retorna401. A prova nativa logout204/rest401 e controle200 do laboratório anterior permanece evidência separada.

Fontes: https://supabase.com/docs/guides/auth/sessions e https://supabase.com/docs/guides/auth/signout ; https://docs.postgrest.org/en/v14/references/transactions.html .
