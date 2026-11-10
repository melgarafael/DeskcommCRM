---
impacto: capacidade_nova
secao: adicionado
titulo: A Ajuda passa a dizer o que o seu papel pode fazer e o que ele não abre
---

A tela **Ajuda** (rodapé do menu) listava os atalhos que a pessoa alcança e não dizia o que ela **pode** naquele papel: quem entra como Somente leitura via o Inbox e não sabia se podia responder, e o Atendente não sabia que configurar o agente é do Gerente.

Agora a Ajuda abre com **"O que o seu papel pode fazer"**: o alcance do papel em uma linha, os atalhos que ele realmente abre e, embaixo, **"O que este papel não abre"** — para a pessoa parar de procurar o que não existe na tela dela. Cada item está preso à tela do menu que o sustenta, e esse vínculo é conferido por teste: um item de "pode" tem de apontar para tela que o papel alcança, um item de "não abre" tem de apontar para tela que ele não alcança. Os atalhos seguem o mesmo filtro do índice: porta que a empresa escondeu do menu não aparece.

O conteúdo é arquivo versionado no repositório, junto da release — sem link externo e sem painel de conteúdo. O papel `ai_operator` não aparece: é o papel do agente publicado, não de uma pessoa. Contribuição de @webtecnica (#3567).
