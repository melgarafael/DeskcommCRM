---
impacto: nada_mudou
secao: corrigido
titulo: A busca do Inbox e a do seletor de etiquetas ignoram acento
---

A busca dentro da conversa e a busca do seletor de etiquetas comparavam o termo com minúsculas apenas: `toLocaleLowerCase` dobra caixa e não acento, então procurar `orcamento` não achava a mensagem "Pode mandar o orçamento?" nem a etiqueta "Orçamento enviado". As duas telas passaram a usar a mesma dobra de acento do repositório (`termoSemAcento`, a régua que o `f_unaccent` do banco espelha): com acento e sem acento dão o mesmo resultado. Contribuição de @webtecnica (#4411, #4410).
