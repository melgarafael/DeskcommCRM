---
impacto: nada_mudou
secao: corrigido
titulo: Editar uma tarefa espera a leitura da situação anterior
---

Se o banco não consegue consultar a situação da tarefa, a edição devolve erro antes de gravar. Assim, corrigir o título de uma tarefa já concluída não cria outra conclusão no histórico do negócio, e o registro de auditoria não inventa uma transição sem ter lido a origem. A edição pode ser tentada de novo quando a consulta se recuperar.

Crédito: @samirhvbr.
