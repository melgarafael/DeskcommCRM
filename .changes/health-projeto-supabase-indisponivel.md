---
impacto: nada_mudou
secao: corrigido
titulo: O diagnóstico de saúde separa o projeto Supabase fora do ar da lentidão
---
Quando o projeto Supabase está fora do ar (resposta `522`, ou `503` com `PGRST002` ao carregar o cache de schema), o `/api/v1/health` agora diz `reason: projeto_indisponivel` em vez de `tempo_esgotado`, e o detalhe autenticado aponta o runbook de recuperação. O runbook de `PGRST002` ganhou o ramo de falta de memória e disco, separado do replay do gateway. Crédito: @webtecnica, a partir do diagnóstico de @DPalmercs na #3677.
