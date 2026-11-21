---
impacto: nada_mudou
secao: corrigido
titulo: O custo gravado do Gemini 3.5 Flash deixa de cobrar o dobro do que o Google fatura
---

Toda instalação com provedor Google atende no `gemini-3.5-flash` — é o modelo padrão do provedor no
catálogo. A tabela de preços do motor cobrava por ele 1,50 de entrada e 9,00 de saída por milhão de
tokens. Esse preço não existe na página oficial: o Google aposentou o 3.5 Flash em 19 de maio de
2026 e o endpoint não foi desligado — ele encaminha toda requisição ao Gemini 3.6 Flash e fatura na
tarifa do 3.6, que é 0,75/3,75 até 31 de dezembro de 2026 e 1,50/7,50 a partir de 1º de janeiro de
2027.

Na prática, cada turno de atendimento em Google gravava em Uso e orçamento 2× a entrada e 2,4× a
saída do que o provedor cobra, e o teto mensal disparava cedo demais. Agora a linha do 3.5 Flash é a
mesma do 3.6 Flash, com a mesma virada de ano — porque o faturamento é o mesmo.

A linha do modelo não sai da tabela: instalação antiga e roteador continuam chamando esse id, e
preço ausente gravaria custo nulo em silêncio. O que muda é o número. A tarifa de modelo aposentado
que não aparece mais na página — os Gemini 2.x — segue preservada.

Nada muda no que o cliente vê além do valor correto na tela de uso: nenhuma configuração, nenhum
modelo novo, nenhum passo de atualização.

Crédito: @webtecnica.
