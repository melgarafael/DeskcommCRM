---
impacto: capacidade_nova
secao: adicionado
titulo: Guarda de promessa aceita condições comerciais autorizadas pela organização
---
Na guarda semântica de promessa, a organização pode declarar as condições comerciais da sua oferta oficial (ex.: "teste de 7 dias, sem cartão") no mesmo mecanismo versionado da tabela de promessas. As condições declaradas são removidas do texto da mensagem antes de o classificador julgar — ele vê só o resto, e a oferta pública do lead não é cortada como promessa não autorizada. Promessa além da oferta continua sendo bloqueada; sem lista declarada, o comportamento anterior é mantido. Observação: ainda não existe tela nem rota para publicar a lista — hoje a declaração é via SQL direto em `promise_table_versions` mais o ponteiro da versão ativa. Condições precisam de ao menos 3 palavras (evita coringa de 1 caractere/palavra). Crédito: @webtecnica.