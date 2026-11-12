---
impacto: capacidade_nova
secao: adicionado
titulo: Cada número pode esperar a IA qualificar antes de distribuir a conversa, com prazo máximo (opção desligada de fábrica)
---

Com rodízio ou menor carga, a conversa nova ganha um atendente em menos de um minuto, e a partir daí a IA para de responder nela. Num número em que a IA faz a primeira triagem, o cliente ficava sem a primeira resposta até alguém olhar o Inbox.

Agora cada número tem uma opção em Configurações → Atendimento → Responsáveis por número: **Esperar a IA qualificar antes de distribuir (minutos)**. Ela vem desligada, e quem não ligar não vê nada mudar.

Com um prazo preenchido (de 15 minutos a 7 dias), a conversa daquele número fica com a IA e sem responsável até a IA passar para uma pessoa. Nessa hora ela entra na distribuição, uma vez, pelo modo escolhido. Se o prazo vencer sem a IA passar, a conversa entra na distribuição do mesmo jeito e a Central avisa: "A IA não passou a conversa no prazo".

A espera só vale onde há distribuição automática (rodízio ou menor carga) e um agente de IA publicado atendendo o número. Número com atendente de destino padrão continua entregando direto para essa pessoa, sem esperar. "Voltar ao padrão da organização" também desliga a espera do número.

Crédito: @webtecnica, que mediu o defeito e escreveu o mecanismo da volta à fila (#4238, issue #3966).
