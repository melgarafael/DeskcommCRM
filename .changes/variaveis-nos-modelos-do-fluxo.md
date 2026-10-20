---
impacto: capacidade_nova
secao: adicionado
titulo: O passo de modelo do fluxo preenche as variáveis do modelo aprovado
---

O passo "modelo de mensagem" de um fluxo agora aceita modelo aprovado com
variáveis (`{{1}}`, `{{2}}`…). Para cada variável, a tela pede de onde sai o
valor: o nome ou o primeiro nome do contato, ou um campo do negócio, como o
produto e o preço que um formulário mandou. O valor é lido na hora do envio.
Uma loja com vários produtos usa um único modelo ("Olá {{1}}! Recebemos seu
pedido de {{2}}…") em vez de um modelo e um ramo do fluxo por produto. Se faltar
a origem de alguma variável, ou o dado estiver vazio no contato, o passo é
pulado e o motivo aparece na linha do tempo — nunca sai parâmetro em branco.
