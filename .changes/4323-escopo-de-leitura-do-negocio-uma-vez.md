---
impacto: nada_mudou
secao: alterado
titulo: Listas de negócios ficam mais leves, porque a permissão de leitura passa a ser resolvida uma vez por consulta
---

Para decidir quem pode ver cada negócio, o banco refazia a mesma conta de permissão a cada linha lida, tanto nos negócios quanto no histórico, nos vínculos e nas cadências de e-mail. Agora a conta é feita uma vez por consulta e reaproveitada. Quem vê o quê não muda: as regras são as mesmas, conferidas linha a linha por teste. A atualização troca as regras de leitura sozinha, sem passo manual.

Crédito: @webtecnica.
