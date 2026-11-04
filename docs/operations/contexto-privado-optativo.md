# Contexto comercial optativo

Destino: núcleo. O recurso é geral, configurado por empresa e sem ativação na migration. Não embute identidades, prompts ou valores de uma instalação.

Entrada e configuração: Equipe, menus de acesso dos atendentes e limites operacionais. As rotas access-scopes e operational-boundaries validam usuário, organização, papel e escrita de suporte; as funções SQL mantêm os gates de escrita. Lista nula permite todo o eixo; lista vazia nega o eixo. A lista de dados compartilháveis é explícita. Ativar a separação é uma operação relevante: precisa da confirmação apresentada na tela e não deve ser usada como simples checkbox de conveniência.

Saídas: contexto reservado do contato, painel de negócios da conversa, dono comercial e retornos do ingresso comercial. O histórico de origem não demonstrada não vira automaticamente conteúdo de um atendimento. A fonte comercial usa binding explícito e recibo pendente quando falta elegível; não troca o executor da IA por observar comercialmente.

Continuidade: resposta manual, contexto das ferramentas, notas/checkpoint, roteiros, follow-ups e casos usam a fronteira do atendimento. O cliente privado recusa operações sem contrato. As funções novas não substituem o resolvedor oficial do dono nem autorizam um humano a tomar conversa de outro. O port conserva a assinatura atual de atribuição com p_source_job_id e a continuidade entre números; não cria overload legado de seis argumentos.

Realtime: exclusões não transportam identificadores de linhas fora da avaliação de SELECT; um sinal sem conteúdo causa nova leitura autorizada. A proteção é global ao transporte e não deve ser confundida com ativação de privacidade de uma empresa. INSERT/UPDATE e a autenticação nativa do canal são preservados.

Auditoria e retorno: alterações comerciais deixam registros e recibos; falha permanece visível nas consultas operacionais. Exportação LGPD inclui os contextos reservados do titular pelo fluxo privilegiado existente, sem remover telefones adicionais nativos. Ativação e ajuste de ACL são decisões humanas, não aprendizado automático.

Reversão: desativar a configuração quando os vínculos e dados forem compatíveis; não apagar quarentena, respostas ou eventos para reverter. Restaurar app antigo com schema novo não equivale a restaurar a política antiga; a compatibilização deve preservar ambos. Não há execução de rollback em produção neste PR.

Validação do port: testes focais de contrato, consumidor e negativa; testes PostgreSQL canônicos acompanham o código. Sem Docker ativo, fresh/update/RLS/REST/Realtime/UI reais e typecheck integral continuam gates de revisão, não resultados presumidos. Os resultados anteriores da instalação motivam a contribuição, mas não homologam automaticamente esta adaptação da main.
