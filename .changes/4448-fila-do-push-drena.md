---
impacto: nada_mudou
secao: corrigido
titulo: Compromisso encerrado para de voltar à fila do Google a cada cinco minutos
---

A fila que empurra os compromissos para a agenda do Google não olhava o estado nem a data: entrava nela todo compromisso já publicado, terminado ou não. Um compromisso que já tinha acontecido — compareceu, faltou ou foi cancelado — voltava à fila a cada cinco minutos, para sempre, e cada volta custava uma leitura no Google para não escrever nada. Numa instalação pequena isso virava cerca de 570 leituras por dia e 2.000 gravações por dia na tabela de compromissos, sem nenhum efeito visível além do ruído.

Agora a fila é só do que ainda pode mudar do outro lado: compromisso pendente ou confirmado que ainda não terminou, e o cancelado — que é o único estado que pede uma escrita no Google, a remoção do evento. Compareceu e faltou saem da fila, porque registrar o desfecho aqui não muda nada no calendário de ninguém.

Nenhuma ação é necessária na atualização. Um compromisso que já terminou sai da fila na primeira rodada depois da atualização, e nada muda para o que ainda vai acontecer.
