---
impacto: exige_acao
secao: corrigido
titulo: IA › Execuções e o Custo da IA voltam a mostrar os dados da organização
---

Numa instalação própria, a tela IA › Execuções aparecia vazia mesmo com a IA
respondendo, e "Evolução da IA" mostrava "Custo da IA no período US$ 0,00". Não
era tela nem coleta: as chamadas estavam gravadas em `llm_calls`, a tabela estava
com RLS ligada e as suas linhas estavam todas na organização certa — o que
faltava era a permissão de leitura. Sem nenhuma policy permissiva, a sessão do
usuário lê zero linha e a soma de custo dá zero. O mesmo valia para
`before_send_traces`, que a tela de retenção da conversa lê.

A atualização não conseguia sair desse estado. A rotina que dá a policy de
leitura a tabela de organização só age em tabela com RLS desligada; numa base em
que a RLS ficou ligada e a policy sumiu, ela passa por cima para sempre, e a
rotina de travas do suporte apenas repõe as restritivas de escrita. Esta versão
traz o conserto em bloco próprio e idempotente: recria a policy de leitura, por
organização, nas três tabelas de telemetria da IA.

Quem atualizar a instalação recupera o histórico existente, sem perder linha e
sem precisar instalar nada — o banco continua com todo o registro do período, e
a tela volta a listá-lo assim que a atualização roda. Contribuição de
@webtecnica (#4527).

## Requer atenção

Rodar a atualização da instalação aplica a policy de leitura — é ela que devolve
as execuções e o custo das chamadas que já estão gravadas. Não há nada a
configurar nem a reinstalar, e nenhum dado é apagado. Se a tela continuar vazia
depois de atualizar, confira em IA › Execuções se o filtro de período está
apertado antes de abrir um chamado.
