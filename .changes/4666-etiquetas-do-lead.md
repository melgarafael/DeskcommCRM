---
impacto: capacidade_nova
secao: adicionado
titulo: Editar etiquetas do lead ganha acrescentar e remover sem apagar as outras
---

Antes, a única forma de mexer nas etiquetas de um lead pela ferramenta era `tags`, e ela SUBSTITUI a lista inteira: o agente que queria acrescentar uma etiqueta mandava só ela e apagava, sem aviso, todas as que já estavam na ficha. Agora existem `tags_adicionar` e `tags_remover`, que fazem a união e a diferença sobre a lista atual, e a descrição de `tags` passou a dizer com todas as letras que ela troca a lista toda. Pedir `tags` junto de `tags_adicionar` ou `tags_remover` na mesma chamada é recusado, para não haver duas intenções no mesmo campo. As etiquetas são normalizadas por espaço e caixa antes de entrar na ficha, então `Cliente VIP` e `cliente vip ` não viram duas. Vale para a ferramenta do agente, para o servidor MCP e para a rota de leads, que compartilham o mesmo esquema. Nada muda para quem já usava `tags` sozinho.

Contribuição de @webtecnica (#4675, #4666).
