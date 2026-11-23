---
impacto: nada_mudou
secao: corrigido
titulo: A mensagem enviada por token de API diz qual integração falou, e o escopo de conversas aparece em espanhol
---

Mensagem enviada por token de API aparecia na conversa como "Sistema": o dono
lia o fio sem saber qual integração havia respondido. A linha agora guarda o
nome do token, lido de `api_tokens.name` no servidor, e o balão mostra
"Integração · <nome do token>". Linha antiga ou token sem nome cai em
"Integração" — o `sent_via` continua o mesmo, e o nome vindo do corpo da
requisição é descartado.

Na tela de Tokens de API em espanhol, o escopo `conversations:write` saía em
português. O rótulo foi traduzido e a cerca que cobra espanhol passou a abrir as
listas iteradas por `.map`, que era o caminho pelo qual esse texto escapava.
