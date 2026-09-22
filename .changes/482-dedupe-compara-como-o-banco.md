---
impacto: nada_mudou
secao: corrigido
titulo: A planilha de produtos compara o código como o banco compara
---

`IP15` e `ip15` na mesma planilha de produtos: a segunda linha era recusada com "código repetido na planilha", recusa que o banco nunca faria — o índice único dele é sobre o código exato, então os dois são produtos distintos. A checagem de repetição da planilha passou a usar a mesma régua: código escrito exatamente igual continua sendo recusado (não sobrescreve em silêncio), e linha que difere só na caixa entra como produto próprio, contada como criada no resumo da importação.
