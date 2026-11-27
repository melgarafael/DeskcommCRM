---
impacto: capacidade_nova
secao: adicionado
titulo: Remarcar com chave de idempotência não remarca duas vezes
---

A ferramenta MCP `crm_reschedule_appointment` aceita `idempotency_key` (opcional) e respeita o cabeçalho `Idempotency-Key` do MCP. Repetir a remarcação com a mesma chave em até 24 h devolve a mesma resposta sem mudar nada de novo, na agenda local e na agenda do Amigo. A mesma chave com outro horário é recusada com `idempotency_conflict`. Sem chave, nada muda.
