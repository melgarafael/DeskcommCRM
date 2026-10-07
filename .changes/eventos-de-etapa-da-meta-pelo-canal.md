---
impacto: nada_mudou
secao: corrigido
titulo: Os eventos de etapa da Meta saem pelo canal da conversa quando não há conexão direta
---

Com as regras de etapa da Meta (Configurações › Conversões), quem não tem token e conjunto de dados próprios — e reporta pela ponte do canal intermediado, como já fazia com a compra — via toda entrada de etapa ficar "Não enviado", com o motivo `sem_conexao`. Agora o evento de etapa vai pelo mesmo caminho da compra: o nome padrão da Meta (o gravado no primeiro envio e, na falta dele, o da regra), o instante da entrada na etapa e nenhum valor, igual ao envio direto. Com a conexão direta configurada nada muda, e os eventos que ficaram parados podem ser reprocessados pelo Histórico de envios. Crédito: @jmpo.

Em Configurações › Conversões, a seção "O que cada etapa do funil informa à Meta" passa a aparecer também para quem envia pelo canal da conversa (a chave "Enviar vendas pelo canal da conversa"); antes ela só aparecia com a conexão direta, e as regras não podiam ser vistas nem editadas pela tela. Crédito: @jmpo.
