---
impacto: nada_mudou
secao: corrigido
titulo: A confirmação de ligar a limpeza de mídia cita o anexo da nota interna
---

Com o #2309, ligar a "Limpeza automática de mídia antiga" passou a apagar também o anexo de nota interna que venceu o prazo. A frase de confirmação mostrada antes de ligar o interruptor, porém, continuava dizendo só "a mídia de mensagem com mais de {n} dias começará a ser apagada" — um consentimento para uma ação irreversível que subdeclara o que ele cobre. A frase de estado "Desligado: a mídia das conversas não é apagada por idade." tinha o mesmo problema, e a frase "Ligado: apaga a mídia com mais de {n} dias." também não citava a nota. As três agora citam o anexo de nota interna junto, em português, espanhol e inglês (pt, es e en). O comportamento da limpeza não muda: continua apagando o que apagava antes, e nenhuma ação é necessária.

Contribuição de @webtecnica (#2466), a partir da issue #2428.
