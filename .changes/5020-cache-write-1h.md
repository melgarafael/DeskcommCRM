---
impacto: nada_mudou
secao: corrigido
titulo: O banco guarda quantos tokens de cache foram gravados com prazo de 1 hora
---

O custo da IA já cobrava separado a gravação de cache de 1 hora e a de 5 minutos, mas `llm_calls` só guardava o total. Agora `cache_write_1h_tokens` guarda a parcela de 1 hora, e a auditoria de custo das chamadas cobradas pela tabela de preços do sistema passa a ter os dois números. As linhas antigas e as chamadas de provedor que não informa a divisão ficam vazias; a tela não muda.

Contribuição de @yunshu0909, a partir da issue #5020.
