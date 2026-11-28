---
impacto: capacidade_nova
secao: adicionado
titulo: Opção para a mensagem enviada pelo celular não pausar a IA antes da primeira resposta do lead
---

Na prospecção, o vendedor costuma complementar a abordagem à mão depois que a campanha dispara — "vi que vocês atendem até 19h, consigo encaixar você amanhã" — e cada mensagem enviada pelo WhatsApp do próprio celular pausava a IA por 60 minutos. O lead respondia "me conta mais" e ficava sem resposta automática, como se a conversa tivesse morrido.

A nova opção fica em Configurações da Prospecção, no card "Pausa da IA na prospecção", e vem DESLIGADA: nada muda para quem não optar. Ligada, a mensagem do celular numa conversa que nasceu de uma campanha não desliga a IA enquanto o lead não respondeu. O limite é explícito: depois da primeira resposta do lead, cada mensagem sua pelo celular volta a pausar a IA como sempre — aí já é atendimento, e a IA não pode falar por cima de quem está negociando. Conversa que não é de campanha de prospecção e o comando `#off` continuam exatamente como estavam.

A dispensa fica registrada na auditoria da mensagem (`pausa_pulada: "prospeccao_sem_resposta_do_lead"`), para que "a IA continuou ligada" seja um fato explicado na trilha, e não um silêncio. Vale para o canal WhatsApp por QR (WAHA); os canais Meta Cloud e Zernio ficam como estão nesta versão. Referente à issue #5179.
