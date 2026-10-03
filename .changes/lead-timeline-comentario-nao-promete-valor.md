---
impacto: nada_mudou        # o operador não precisa fazer nada
secao: corrigido
titulo: O comentário da timeline do negócio não promete mais o valor anterior no log de auditoria
---
O comentário que acompanha as edições de um negócio dizia que quem
precisa do valor anterior tem o `api_audit_log`. O log de auditoria de
`lead.updated` guarda só os nomes dos campos alterados, nunca o antes-e-depois —
o valor anterior não estava em lugar nenhum. O comentário agora diz o que o
código faz: o valor anterior não é guardado; guardar o antes-e-depois de campos
sem PII segue em aberto na #1755.
Crédito: @webtecnica.