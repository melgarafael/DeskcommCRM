---
impacto: nada_mudou
secao: corrigido
titulo: Recorrências além da milésima deixam de ficar sem lançamento no mês
---

O cron que gera os lançamentos das recorrências passa a ler todos os moldes ativos página por página, em vez de só a primeira resposta do banco. Numa instalação com mais de 1.000 recorrências ativas, um molde devido que caísse depois da milésima linha não gerava o lançamento do mês e a rotina respondia sucesso, como se não houvesse nada a gerar. O campo `moldes` da resposta passa a informar o total realmente lido. A partir de 50 mil moldes ativos a leitura para, e o restante fica declarado fora — o mesmo teto da leitura de métricas do Jev.
