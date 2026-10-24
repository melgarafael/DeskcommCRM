# Histórico pertinente na avaliação de sentimento

CONFIRMADO pelo contrato desta mudança: com aceite administrativo específico
`settings.jev.contexto_clima`, a avaliação de sentimento recebe a mensagem atual
e até 16 mensagens anteriores do mesmo atendimento (máximo de 16 mil caracteres
de histórico, preservando mensagens inteiras). Sem aceite, permanece a mensagem
isolada. O limite de transferência continua sendo configuração própria do agente.

A leitura usa organização, conversa, revisão e instante da mensagem persistida.
Saídas só entram com estado enviado/entregue/lido e envio anterior à fronteira.
Mensagens anonimizadas e saídas ainda não enviadas são excluídas. Ausência,
omissões conhecidas e limite da janela são explícitos, sem supor inexistência.
Dados reconhecidos pelo redator nativo são ocultados antes do envio aos modelos.
Histórico é dado para desambiguar a mensagem atual, nunca instrução ou autoridade.

Jev e reserva recebem a mesma fotografia enquanto o aceite permanecer válido.
O aceite é revalidado antes da rede; se revogado, a reserva usa a mensagem
isolada. Trocar a origem invalida este aceite. Ele não autoriza histórico para
roteamento, revisão, manipulação, pedido de humano ou outras tarefas.

A telemetria guarda quantidade, cobertura, omissões conhecidas e fingerprint
do pacote efetivamente usado, sem duplicar o texto privado. Isso prova o recorte
utilizado, não a correção universal da classificação. O papel e os critérios dos
modelos permanecem independentes: a mensagem atual é o alvo da nota; emoção
antiga não deve ser transferida automaticamente para uma resposta neutra.

Validação dirigida: worker real com banco/fornecedores dublês, transporte comum,
isolamento, fronteira, saídas não enviadas, ausência/revogação do aceite e UI/API
administrativas. Uma nova conversa real continua sendo prova separada.
