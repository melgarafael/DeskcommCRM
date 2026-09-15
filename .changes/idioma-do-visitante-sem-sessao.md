---
impacto: capacidade_nova
secao: adicionado
titulo: Quem ainda não tem conta já vê login, cadastro, convite e páginas legais em espanhol
---

O idioma da interface sempre dependeu de uma sessão: `preferência da pessoa → idioma da
organização → padrão`. Fora dessa cadeia — login, cadastro, aceite de convite, política de
privacidade e termos — não havia nenhum sinal para seguir, e a tela caía sempre em português,
mesmo para quem nunca vai ler português.

Agora essas telas também consultam o `Accept-Language` que o navegador já manda em toda
requisição: se o visitante não tem preferência salva (é a primeira vez, ainda não tem conta),
o idioma dele na lista de preferências decide. Uma preferência já salva continua vencendo
sempre — isto só entra em jogo para quem a tela nunca viu antes.
