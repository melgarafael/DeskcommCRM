---
impacto: nada_mudou
secao: corrigido
titulo: Um PDF recebido no WhatsApp não derruba mais o worker
---

Desde a 1.83.0 o worker passou a ser iniciado de um jeito novo, e a leitura de PDF deixou de rodar no processo separado que a protegia. Um comprovante em PDF recebido pelo WhatsApp podia esgotar a memória do worker e reiniciá-lo várias vezes, interrompendo respostas do agente e deixando o alerta "fila de eventos parada" aceso. A leitura de PDF volta a rodar à parte, e um arquivo pesado não derruba mais o atendimento.
