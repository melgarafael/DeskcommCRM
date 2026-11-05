---
impacto: capacidade_nova
secao: adicionado
titulo: A distribuição automática pode esperar a IA qualificar antes de entregar a conversa a uma pessoa
---

Com rodízio ou distribuição por carga ligados, a conversa nova ganhava um
atendente no primeiro minuto — e a atribuição calava a IA, que era justamente
quem deveria qualificar o cliente. Na prática o lead recebia a primeira
resposta do agente e parava ali, esperando alguém abrir a conversa.

A tela Distribuição de atendimento ganhou a opção **Esperar a IA qualificar antes de distribuir**. Ligada, a conversa fica com a IA e sem dono enquanto ela qualifica, e só entra na distribuição quando a qualificação termina: a IA passa a conversa para uma pessoa, abre um caso para a equipe ou avança o lead no funil. Aí a atribuição acontece uma única vez e a IA fica calada, como sempre ficou depois que a conversa tem dono.

A opção só vale onde há agente de IA atendendo o número. Sem agente, com o
agente pausado, com o contato marcado como sempre humano, com a IA silenciada
ou com o caso já pedindo a equipe, a conversa é distribuída na hora — o modo
novo não trava a operação de quem não tem IA.

Existe também um limite, **de um dia** por padrão (ajustável de 15 minutos a 7
dias), contado do início da conversa: se a qualificação não terminar nesse
prazo, a conversa entra na distribuição mesmo assim. O limite existe porque o
fim da qualificação depende de o modelo chamar as ferramentas de caso e de
estágio — um agente sem essas ferramentas, ou um cliente que para de responder,
nunca produziria o sinal, e a conversa ficaria sem dono para sempre.

Desligada, a opção mantém o comportamento de sempre: a conversa é distribuída
assim que chega.
