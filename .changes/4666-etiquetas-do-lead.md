---
impacto: capacidade_nova
secao: adicionado
titulo: Editar etiquetas do lead ganha acrescentar e remover sem apagar as outras
---

Antes, a única forma de mexer nas etiquetas de um lead pela ferramenta era `tags`, e ela SUBSTITUI a lista inteira: o agente que queria acrescentar uma etiqueta mandava só ela e apagava, sem aviso, todas as que já estavam na ficha. Agora existem `tags_adicionar` e `tags_remover`, que fazem a união e a diferença sobre a lista atual, e a descrição de `tags` passou a dizer com todas as letras que ela troca a lista toda. Quando vêm juntas na mesma chamada, `tags` define a base, depois entram os acréscimos e por fim saem as remoções. As etiquetas são normalizadas por espaço e caixa antes de entrar na ficha, então `Cliente VIP` e `cliente vip ` não viram duas. Vale para a ferramenta do agente, para o servidor MCP e para a rota de leads, que compartilham o mesmo esquema. Quem já usava `tags` sozinho continua substituindo a lista inteira; a diferença é que a etiqueta nova agora entra normalizada (sem espaço nas pontas e em minúscula), e a grafia que já existe no negócio é mantida.

Contribuição de @webtecnica (#4675), a partir da issue de @hudson-souza-mkt (#4666).
