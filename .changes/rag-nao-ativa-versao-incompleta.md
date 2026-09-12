---
impacto: nada_mudou
secao: corrigido
titulo: O indexador RAG para de ativar versão com trechos faltando
---

Ao reindexar uma fonte de conhecimento (uma FAQ, um documento, o catálogo), cada
trecho do material é gravado um a um. Quando a gravação de um trecho falhava, o
erro ia só para o log do servidor e a indexação seguia em frente: bastava que
algum outro trecho tivesse gravado para a versão nova ser dada como pronta e
entrar no ar. Quem conversava com o agente passava a receber respostas apoiadas
num acervo furado, e a versão anterior, completa, saía de cena sem aviso — a
pessoa só descobria o buraco ao perguntar exatamente o que faltou.

Agora falha de gravação derruba a indexação inteira. Se qualquer trecho não
gravar, a versão nova é registrada como falha, com o motivo (quantos trechos
faltaram e em quais posições), e a versão anterior continua ativa e respondendo.
O registro da falha também aponta o detalhe `trechos_nao_gravados:N`, para a
triagem dizer de bate-pronto se o problema foi parcial. Quando nada grava, o
detalhe segue sendo o `nenhum_trecho_gravado` de sempre.

Não muda nada quando tudo grava: a versão nova é marcada como pronta e ativada
como antes, e o caminho de erro de embedding (chave ausente ou provedor
recusando) continua igual, derrubando a indexação sem ativar. Quem nunca viu um
buraco no índice não vê diferença nenhuma.
