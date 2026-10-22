---
impacto: nada_mudou
secao: corrigido
titulo: Desambiguação de relacionamento no PostgREST para organizações (#3219)
---
Remove a chave estrangeira redundante `calendar_service_professionals_organization_id_fkey` que criava relação Many-to-Many espúria no PostgREST entre membros e organizações (erro PGRST201). A integridade referencial de `organization_id` permanece estritamente garantida pela chave composta `calendar_service_professional_member_fk`. Crédito: @patronotech.
