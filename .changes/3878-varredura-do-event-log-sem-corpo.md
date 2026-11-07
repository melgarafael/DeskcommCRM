---
impacto: nada_mudou
secao: corrigido
titulo: A varredura de eventos não carrega mais o corpo de quem não vai processar
---

As duas rotinas que varrem a fila de eventos (`event_log`) — o dreno genérico do cron e o worker de roteamento — liam **o corpo do evento de todas as linhas do lote**: até 50 no dreno e até 100 no roteamento, a cada minuto. O corpo é o `payload` com os dados do que disparou o evento e o `metadata` que os handlers escrevem nele, e a maioria dessas linhas nem chegava a ser processada no tique.

Agora a varredura pede só **as colunas que decidem se a linha interessa** (identificador, organização, tipo do evento, quem já consumiu e número de tentativas), e o corpo é lido **apenas do item reclamado para processar** — na mesma chamada que já marcava a linha como `processing`, então não há requisição nova. Medido num Postgres com as formas de `payload` que o próprio sistema emite: o lote do dreno caiu de **27,5 KB para 13,3 KB por tique** e o do roteamento de **42,2 KB para 14,1 KB**, com o mesmo número de chamadas ao banco.

O desfecho de cada evento não mudou: quem é processado continua sendo processado uma vez só (a marcação atômica é a mesma), evento com erro continua voltando para a fila com espera e virando `dead` no limite de tentativas, fila vazia continua sem leitura extra, e as organizações pausadas continuam intocadas. Nada a fazer na instalação.
