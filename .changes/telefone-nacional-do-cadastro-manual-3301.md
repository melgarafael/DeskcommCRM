---
impacto: capacidade_nova
secao: adicionado
titulo: Cadastro de contato aceita o telefone como o brasileiro escreve e grava o +55 sozinho
---

Quem cadastra contato à mão numa organização brasileira tinha de digitar o número no formato internacional completo — `+5542998737374` —, com o `+` e o código do país, sob pena de o campo recusar com "Telefone deve estar em formato E.164". Agora o campo aceita o número como o brasileiro escreve: `(42) 99873-7374`, `42 99873-7374`, `42998737374`, `(42) 3333-4444` para fixo — com ou sem máscara —, e também o número colado com o `55` na frente mas sem o `+`. O `+55` entra uma vez só, e o contato é gravado em E.164, exatamente como antes: nada muda no banco nem para quem já tinha o número gravado.

O DDD é conferido pela mesma régua que o produto já usa para reconhecer o mesmo número em duas grafias — dois dígitos, o primeiro de 1 a 9 —, então DDD inválido e tamanho errado continuam sendo recusados, agora com uma mensagem que mostra os dois exemplos (o nacional e o E.164). A normalização mora na regra do cadastro, não só na tela: a API de contatos (`POST` e `PATCH /api/v1/contacts`) passa a aceitar o mesmo formato nacional numa organização brasileira, e integração que já manda E.164 segue igual. Número escrito com `+` mantém o código de país que a pessoa digitou, mesmo com espaços e parênteses — `+1 (415) 555-1234` continua sendo dos Estados Unidos.

Organização de outro país segue igual: o formato internacional completo continua sendo o único aceito, e a mensagem de erro continua ensinando o código do país de lá. O rótulo do campo passa a dizer "Telefone (DDD + número)" no Brasil. Nada a fazer na atualização.

Contribuição de @webtecnica (#3305).
