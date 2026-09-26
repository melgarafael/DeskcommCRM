---
impacto: nada_mudou
secao: corrigido
titulo: Follow-up de silêncio para de mandar mensagem a cada poucos minutos para o mesmo contato
---

Um fluxo de follow-up disparado por silêncio (ex.: "Triagem parada") reinscrevia o mesmo contato a cada rodada do relógio (1×/min), assim que o envio anterior terminava — em vez de esperar o intervalo de silêncio configurado (ex.: 2 horas) entre uma tentativa e outra. Um contato que nunca respondia recebia uma mensagem nova a cada poucos minutos, indefinidamente — medido numa instalação real: 32 disparos em cerca de 9 horas para o mesmo número, risco real de o número ser marcado como spam pelo WhatsApp. Agora a varredura respeita o intervalo configurado entre o fim de uma tentativa e o início da próxima para o mesmo contato no mesmo fluxo. Ninguém precisa reconfigurar nada.
