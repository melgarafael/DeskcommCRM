---
impacto: capacidade_nova
secao: adicionado
titulo: A importação de empresas e pessoas confere o arquivo antes de gravar e não duplica o que já existe
---

Antes, reimportar a mesma planilha criava pessoas repetidas e o lote dizia "sucesso". Agora, em **Importações**, o botão **Conferir arquivo** mostra quantas linhas são novas, quantas já existem, quantas estão em conflito ou repetidas, quantas não têm telefone e quantas são inválidas, **sem gravar nada**. Há só duas saídas: **importar só as novas** ou **baixar o CSV do que ficou de fora**, que diz o motivo de cada linha e de quem é o que já existe. "Já existe" é celular ou e-mail iguais (o nome não conta, e e-mail de caixa compartilhada como `contato@` ou `vendas@` vale só pelo celular) ou empresa com o mesmo CNPJ; essas linhas não são reaproveitadas nem sobrescritas. Dentro da planilha, linha idêntica é descartada e celular ou e-mail iguais com dados diferentes viram conflito. Linha sem telefone não entra. A API aceita `previa=true` no `POST /api/v1/imports`, e sem ele o servidor confere de novo e grava só as novas. Nenhuma ação é necessária na VPS.
