---
impacto: nada_mudou
secao: corrigido
titulo: A promessa de retorno do assistente passa a ser verificada também com os casos humanos desligados
---

O gate de promessa de caso liberava tudo na primeira linha quando os casos humanos estavam desligados, que é o padrão de um agente novo. Mas a frase em que o assistente se compromete a retomar a conversa ("combinado, retomamos daqui a duas horas") não depende de caso: o destino dela é o `schedule_followup`, e sem ele o cliente fica esperando uma mensagem que não vem. Agora o retorno do próprio assistente é verificado antes da guarda de casos, com código próprio (`followup_promise_without_followup`) para não se confundir com o veto que abre caso. Promessa de humano e promessa de conteúdo continuam como estavam; com os casos ligados, o comportamento é o mesmo de antes, inclusive o fail-safe que abre o caso. Contribuição de @webtecnica (#3856).
