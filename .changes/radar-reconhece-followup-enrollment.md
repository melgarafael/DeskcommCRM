---
impacto: nada_mudou
secao: corrigido
titulo: Radar de risco passa a reconhecer follow-ups ativos de cadência como em voo
---

Demandas abertas com follow-up ativo na cadência moderna (`followup_enrollments`) apareciam no Radar de risco como "em risco" ou "crítico" (sem próximo passo), porque o radar consultava apenas a tabela legada de agendamentos pontuais (`cron_jobs`). Agora o radar consulta tanto `cron_jobs` quanto `followup_enrollments` (com status ativo/em espera) e considera o retorno mais próximo no futuro, exibindo a demanda corretamente como "em voo".
