# Sessão ativa e avisos recuperáveis

A migration 9110 compõe a guarda de sessão com o pre-request de replay existente. Um hook de terceiros desconhecido interrompe a instalação: deve ser composto explicitamente, sem substituição silenciosa. Authenticated precisa de JWT nativo válido, `sub`, `session_id`, `exp` e sessão GoTrue ainda ativa. Anon e service_role conservam a validação nativa; não recebem detalhes de avisos por esse mecanismo.

Quinze tabelas recebem uma policy SELECT restritiva adicional para CDC. O transporte em `realtime_invalidations` leva somente organização, tipo e nonce; os detalhes são relidos pelas rotas autorizadas. Central e painel administrativo mantêm consumidores separados e recibos por usuário. Um recibo confirma apresentação, não execução da demanda nem leitura humana.

Episódios derivados são registrados em melhor esforço. Falha de captura emite aviso sanitizado e preserva a mutação de negócio; o sistema não promete histórico completo nem reconstrói eventos anteriores à ativação. O bootstrap inicial sem avisos é idempotente. Reconexão e polling autorizado permitem recuperação dos registros retidos.

## Verificação necessária antes de adotar

Os testes focais do PR verificam consumidores, cancelamento por identidade, validação de recibos e respostas negadas. Não substituem fresh/update PostgreSQL, Auth/REST com JWT nativo, logout e revogação no WebSocket real. Verificar também MFA e suporte, reabertura da aba, contagem de episódios acima de uma página e ausência de payload sensível no CDC. Um token antigo que ainda não expirou não pode ser tratado como sessão ativa após logout.

## Reversão

Preservar o valor anterior de `pgrst.db_pre_request` e o inventário de policies/triggers antes da aplicação. Retomar o app anterior exige coordenar esse hook e os objetos novos, sem apagar recibos ou histórico. Não remover signing keys, sessões ou volumes para reverter. Restaurar o transporte antigo perde as garantias desta contribuição; precisa de decisão explícita do operador.
