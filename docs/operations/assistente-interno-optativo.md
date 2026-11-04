# Assistente interno optativo

Protótipo genérico, desligado por padrão. Disponível somente para usuário e organização permitidos no servidor. Não é agente que atende clientes nem operador autônomo.

Flags opcionais: `ASSISTANT_PILOT_ENABLED=true`, `ASSISTANT_PILOT_ORGANIZATION_ID` e `ASSISTANT_PILOT_OWNER_USER_ID`. Ausência mantém interface oculta/rota indisponível. O operador seleciona IDs existentes na instalação; o body não decide a identidade. Suporte fica excluído. Nenhuma variável é obrigatória na instalação nova.

Botão na casca do CRM; modelo/credencial pela configuração nativa Agente de IA › Provedores. Um turno consome inferência somente após solicitação do usuário na tela. A única ferramenta consulta até 20 conversas pelo handler autorizado, sem mensagens, agendamento, transferência ou campanha. Timestamps/unread/status não são diagnóstico semântico; o resultado declara esse limite.

Histórico pessoal separado dos clientes, leitura do próprio usuário com vínculo ativo; escrita somente backend. Reserva antes da inferência bloqueia repetição de resultado incerto. Texto expirado deixa de ser lido após 90 dias; nenhuma rotina de exclusão é criada. Decidir retenção antes de habilitar.

Erro e recibo aparecem no painel. Turno incerto exige releitura, nunca reenvio automático. Reversão: desligar flag e preservar histórico; voltar a app compatível sem apagar tabelas. Testes focais não comprovam inferência real, concorrência, MFA/RLS integrada ou jornada completa; teste DB acompanha o conjunto canônico para revisão.
