---
impacto: nada_mudou
secao: corrigido
titulo: Os crons de minuto param de consultar o banco quando não há trabalho
---

Numa instalação sem webhook a reprocessar, sem follow-up, sem janela de pausa e sem proposta em envio, quatro rotas de cron faziam seis consultas de minuto em minuto para voltar sempre vazias. Agora elas consultam o piso ocioso (#3731), que já fazia isso para as campanhas, a prospecção, o histórico e a Google Agenda. O piso responde de uma leitura só, pelo banco direto e sem gastar requisição do PostgREST, válida por 30 segundos e dividida por todas as rotas.

Quem tem trabalho não sente diferença. O que nasce dentro do próprio app é visto já na batida seguinte, sem esperar a janela: uma inscrição feita num fluxo de follow-up, ou um contato que a varredura de silêncio inscreveu. Nada muda para quem opera a VPS: não há função nova no banco nem arquivo para editar. Crédito: @webtecnica.
