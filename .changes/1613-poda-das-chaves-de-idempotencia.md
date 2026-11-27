---
impacto: nada_mudou
secao: corrigido
titulo: A limpeza diária passa a apagar as chaves de idempotência vencidas
---

As chaves de idempotência dos envios pela API e pelas ferramentas do MCP (e o recibo da resposta guardado nelas) nunca eram apagadas, e a tabela só crescia. A limpeza diária agora apaga, em lotes, as que venceram há mais de um dia; as chaves válidas e o recibo da aprovação de pedido LGPD não são tocados. Nada muda para quem usa.

Contribuição de @yunshu0909, a partir da issue #1613.
