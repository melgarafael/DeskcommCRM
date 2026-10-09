---
impacto: nada_mudou
secao: corrigido
titulo: Poda de retenção interrompida no meio leva as contagens dos lotes que já passaram
---

Quando uma poda de retenção falha no meio dos lotes (o banco cai no quarto de vinte, por exemplo), os lotes anteriores já foram apagados — mas o relatório e a auditoria registravam zero para aquela tabela, como se nada tivesse sido apagado. No expurgo da auditoria isso significava apagar linhas e contá-las como zero na própria trilha. Agora a contagem dos lotes que passaram aparece no relatório, na auditoria e na resposta do cron, que também passa a devolver o relatório completo quando alguma poda falha. As mensagens de falha perdem o nome repetido e voltam a ser cortadas em 300 caracteres.

Contribuição de @Tong-bit-art (#2653), a partir da issue #2508 e das sugestões do #2645.
