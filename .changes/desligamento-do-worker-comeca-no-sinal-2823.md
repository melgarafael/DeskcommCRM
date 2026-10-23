---
impacto: nada_mudou
secao: corrigido
titulo: O prazo do desligamento do worker começa no sinal e cabe no prazo do kit
---

O worker passa a contar o prazo total do desligamento a partir do SIGTERM/SIGINT, e não depois de esperar os laços e o workerLoop: laços, drain dos jobs em voo e fecho do pool entram dentro da contagem, então um laço preso numa chamada de rede deixa de ficar por fora do SHUTDOWN_GRACE_MS — era isso que fazia uma parada ociosa passar de 19 s. O docker-compose.prod.yml e o .env gerado pelo hostgator-setup-kit passam a declarar stop_grace_period (40 s) acima do prazo interno (30 s): sem essa chave o Docker usava o padrão de 10 s e mandava SIGKILL no meio do drain. Nenhum timeout de supervisor foi aumentado como conserto.
