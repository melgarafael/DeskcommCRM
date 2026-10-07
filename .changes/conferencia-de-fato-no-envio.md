---
impacto: capacidade_nova
secao: adicionado
titulo: O Jev passa a conferir se o que o agente afirma sobre o negócio está no material consultado
---

Antes de cada resposta do agente sair, o Jev pode conferir as afirmações de fato que ela faz sobre o negócio (horário, preço, endereço, o que o lugar tem ou não tem) contra o material que o agente consultou naquele turno. Uma frase como "o check-in é a partir das 12h", quando o material diz 14h, é marcada como contradição; "temos piscina aquecida", quando o material não fala de piscina, é marcada como fora da base. Perguntas, saudações e links ficam de fora da conferência, e quando o agente não consultou material nenhum no turno, a conferência não roda.

**Nasce em observação e não muda nada para o cliente.** O Jev vem desligado por padrão. Ligado, esta conferência só anota o que encontrou, na tarefa nova "Conferir afirmações de fato na resposta", no cartão do Jev, e a mensagem segue como hoje: nesta versão a tarefa não oferece "Deixar o Jev decidir". A guarda de promessa ("faço de graça", "entrego amanhã") não muda.

**Custo:** com o Jev ligado, no máximo uma chamada a ele por turno do agente que tenha consultado material, e ela entra no Uso de IA e soma no consumo do mês. Uma reescrita da mesma resposta reaproveita a conferência e não paga de novo. A chamada acontece antes de o envio reservar a vez do número, junto da conferência de promessa, e não prende a fila do WhatsApp.

Contribuição de @webtecnica (#2231).
