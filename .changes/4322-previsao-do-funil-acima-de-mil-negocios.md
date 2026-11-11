---
impacto: nada_mudou
secao: corrigido
titulo: A previsão do funil soma todos os negócios abertos, mesmo acima de 1.000
---

Num funil com mais de mil negócios abertos, a previsão (a tela de Métricas, a rota `GET /api/v1/pipelines/{id}/forecast` e a ferramenta `crm_get_pipeline_forecast`) lia um pedaço arbitrário da carteira: o banco corta toda resposta em 1.000 linhas, sem erro, e a soma saía menor que a real sem nenhum aviso. Com a probabilidade vinda da inteligência artificial, a leitura das pontuações trazia a organização inteira, de todos os funis, e também era cortada.

Agora os negócios abertos e as pontuações do funil são lidos por páginas, em ordem estável, e a previsão soma todos. Se a carteira passar do teto de leitura (5.000 negócios), a resposta traz `truncado: true` (e o cabeçalho `X-Previsao-Truncada: 1`) e a tela de Métricas avisa que os valores são parciais, em vez de apresentar um recorte como o total. Funis menores respondem exatamente o que respondiam antes.
