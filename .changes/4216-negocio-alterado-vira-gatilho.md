---
impacto: capacidade_nova
secao: adicionado
titulo: Automação nova "Quando um negócio for alterado", com condição pelo campo que mudou
---

Até aqui, editar um negócio não disparava nenhuma automação: não havia como montar "quando a data prevista mudar, avise o responsável" ou "quando o valor for preenchido, mova para a próxima etapa".

Agora, em Automações, o gatilho "Quando um negócio for alterado" dispara quando os dados do negócio são editados (mudar de etapa continua sendo o gatilho de etapa). Na condição "Nome do campo alterado · foi alterado", você escolhe numa lista qual campo precisa ter mudado (título, valor, data prevista de fechamento, responsável, tags, campos personalizados e os demais do negócio). Salvar o negócio sem mudar nada não dispara a automação, e a alteração feita por outra automação também não dispara, para uma regra não ficar disparando a si mesma.

As edições feitas antes da atualização não disparam regra nenhuma.

Contribuição de @webtecnica, a partir da issue #1749 (#4216).
