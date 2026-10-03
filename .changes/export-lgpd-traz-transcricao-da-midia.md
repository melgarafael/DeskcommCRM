---
impacto: nada_mudou
secao: corrigido
titulo: Exportação LGPD do titular passa a incluir a transcrição/texto extraído da mídia
---

Quando um titular pede acesso aos próprios dados (LGPD Art. 18 II), o arquivo gerado (`data.json` + `report.pdf`) dizia que a mensagem tinha mídia, mas não trazia a transcrição do áudio nem o texto extraído da imagem — o conteúdo que a IA efetivamente leu. O binário da mídia continua fora do pacote. Agora o export traz `media_derived_text` de cada mensagem do titular, com rótulo legível no relatório ("transcrição/texto extraído da mídia"), e a de outros contatos continua fora do pacote. Na prévia da solicitação, a transcrição aparece mascarada, como o corpo da mensagem. Sem ação do operador: o worker gera o mesmo `data.json` e `report.pdf`, agora mais completos.

Refs #1990

Contribuição de @webtecnica (#2020).
