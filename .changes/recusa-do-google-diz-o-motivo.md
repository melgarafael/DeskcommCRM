---
impacto: nada_mudou
secao: corrigido
titulo: A recusa do Google passa a dizer o que aconteceu
---

Quando o Google recusava uma alteração da Agenda, o erro gravado no compromisso dizia apenas "Google HTTP 400". O Google já tinha dito o motivo na resposta (`invalid`, `insufficientPermissions`, `rateLimitExceeded`…), mas ele era descartado antes de virar a frase. Agora a frase diz o tipo da recusa (sem permissão no calendário, limite de uso do Google, evento que não existe mais, recusa que repetir não resolve), o código HTTP e o motivo que o Google mandou — por exemplo: "o Google recusou e repetir não muda o resultado — HTTP 400 (invalid)".

O compromisso recusado continua marcado com erro e continua sendo reexaminado pela sincronização, como antes. Da resposta só entra o que tem formato de identificador (letras e sublinhado): e-mail de convidado e frases ficam de fora da frase, que é gravada e mostrada na tela. Quando o calendário inteiro foi apagado no Google, a frase agora diz isso, em vez de falar do evento. Nada para configurar. Crédito: @webtecnica.
