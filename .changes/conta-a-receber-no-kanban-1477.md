---
impacto: capacidade_nova
secao: adicionado
titulo: Fechar um pedido como ganho no Kanban abre a comanda com o valor e o contato do negócio
---

Mover o card para a etapa de ganho (`is_won`) fechava o negócio no CRM e não dizia nada ao financeiro: quem vendia pelo Kanban tinha de lembrar de ir na tela de Comandas abrir o recebimento à mão, em outra tela, sem nenhum vínculo entre as duas. Agora o arrasto para a etapa de ganho abre **uma comanda** com o **valor** (`crm_leads.value_cents`) e o **contato** que já estão no negócio, com a moeda da organização, e grava o vínculo dela com o negócio em `crm_lead_links` (`target_kind = 'order'`, valor que o CHECK já aceitava).

A própria ligação é a trava de idempotência: fechar, reabrir e fechar de novo devolve a comanda que já existe em vez de abrir outra, e uma etapa que não é ganho não toca no financeiro. A comanda nasce ABERTA de propósito — o operador confere o valor e finaliza com a forma de pagamento, e é `fn_finalizar_comanda`, o caminho de sempre, que transforma isso em entrada de conta a receber. Sem migration: a origem do lançamento fica no `metadata` do vínculo (`ganho_no_kanban`), porque `financial_entries.origin` tem CHECK fechado.

Contribuição de @webtecnica (#2220, refs #1477).
