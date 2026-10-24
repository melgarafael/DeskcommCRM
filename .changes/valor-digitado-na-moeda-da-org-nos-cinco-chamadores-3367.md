---
impacto: nada_mudou
secao: corrigido
titulo: Comandas, faturamento, honorários, agenda e recorrências leem o valor digitado pela moeda da organização
---

Numa organização cuja moeda não é o real, digitar `1,300` no preço de um item de comanda, num lançamento avulso do faturamento, numa parcela de honorários, no preço padrão de um tipo de agendamento ou num lançamento de todo mês gravava **1,30** — cem vezes menos. Essas cinco telas liam o número pela régua do real; agora cada uma lê pela moeda da organização, a mesma do valor do negócio e do catálogo (#3331, #3365).

Em real nada muda: `1,30` continua um e trinta e `1.300` continua mil e trezentos.

Fica declarado o que NÃO se resolve: a vírgula com dois dígitos depois (`1,30`) continua sendo lida como 1,30 em qualquer moeda — dois dígitos não são grupo de milhar em convenção nenhuma. Quer dizer 130 dólares, digite `130` ou `1.30`. E nas parcelas de honorários o valor JÁ GRAVADO continua apresentado em real na tabela, como antes; o conserto é na leitura do que se digita agora.

Nada a fazer na atualização.

Contribuição de @webtecnica (#3367).
