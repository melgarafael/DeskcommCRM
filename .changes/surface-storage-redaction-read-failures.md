---
impacto: nada_mudou
secao: corrigido
titulo: Falha ao ler a fila de remoção de mídia passa a aparecer como rodada de cron com erro
---
Quando o worker que remove as mídias apagadas (LGPD e retenção) não consegue ler a fila, o cron agora responde erro em vez de relatar um lote vazio com sucesso. O agendador passa a registrar a rodada como falha, e o identificador da requisição liga a resposta ao log da aplicação. Os arquivos pendentes continuam na fila para a próxima tentativa. Crédito: @samirhvbr.
