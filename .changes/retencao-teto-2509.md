---
impacto: nada_mudou
secao: corrigido
titulo: Um prazo de retenção enorme no .env não trava mais a limpeza diária
---

Um prazo de retenção gigante no `.env` (por exemplo `AUDIT_LOG_RETENTION_DAYS=9999999`) chegava ao banco como uma data de corte fora de qualquer calendário, e a limpeza diária (`data-retention`) parava naquela tabela em toda rodada: ela e as que vêm depois deixavam de ser podadas, e a retomada de anonimização da LGPD daquela rodada também não rodava. Agora os prazos da limpeza diária e o da captação de leads têm teto de 36500 dias (100 anos): um valor acima disso é trocado pelo teto, e o log avisa que o número escrito não foi usado, no mesmo formato do aviso de piso. Prazos dentro do intervalo não mudam. Nada precisa ser feito ao atualizar. Contribuição de @webtecnica (#2603, issue #2509).
