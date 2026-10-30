---
impacto: nada_mudou
secao: corrigido
titulo: "Quem não tem nome cadastrado aparece pelo e-mail ou por um código curto, nunca pelo identificador interno"
---

Membro da equipe sem nome no cadastro aparecia de jeitos diferentes em cada tela, e quase sempre com um pedaço do identificador interno, como `Atendente 4fa3917a`. Transferir conversa, menção na nota, funil, tarefas, carteira do contato, automações, financeiro e agenda passam a usar a mesma regra: o nome, depois o e-mail (só nas telas que já mostravam o e-mail), depois `Atendente` com um código curto que não é pedaço do identificador.

A trilha de auditoria segue mostrando o começo do identificador de quem agiu, porque é o que casa com o filtro e com o CSV exportado.

Crédito: @webtecnica.
