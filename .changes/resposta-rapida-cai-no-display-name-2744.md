---
impacto: nada_mudou
secao: corrigido
titulo: Resposta rápida com {{nome}} usa o display_name quando o contato não tem nome
---

Quem usava uma resposta rápida com `{{nome}}` ou `{{primeiro_nome}}` numa conversa aberta pelo WhatsApp recebia a variável literal no corpo da mensagem — `Oi {{primeiro_nome}}, segue o catálogo!` — porque o compositor só olhava o `name` do contato, e o contato que nasce pelo canal chega com `name` vazio e só o `display_name` preenchido. Agora o compositor cai no `display_name` quando o `name` está vazio, e a resposta sai com o nome da pessoa. O mesmo vale para a legenda de uma resposta rápida com imagem, que é o texto do próprio compositor.

Sem nenhum dos dois nomes, o texto continua saindo com a variável literal (nada é inventado no lugar do nome), e o compositor avisa o operador na hora em que o modelo é aplicado, para ele editar antes de enviar.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2764), a partir da issue #2744.
