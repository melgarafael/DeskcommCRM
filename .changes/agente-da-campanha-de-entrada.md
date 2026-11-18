---
impacto: capacidade_nova
secao: adicionado
titulo: O cliente que chega pela frase do anúncio é atendido pelo agente daquela campanha
---

Quem anuncia no Meta ou no Google com uma frase identificadora ("quero saber
mais sobre implantes") já tinha o contato reconhecido como elegível para a IA.
Mas quem respondia era o agente do **número**: para quem atende vários nichos no
mesmo WhatsApp, a pergunta sobre implantes saía pelo agente do outro nicho.

Agora a campanha de entrada pode declarar o agente dela — o campo `agent_id`, que
já existia na configuração e era ignorado — e a conversa que chegou por aquela
frase é atendida por esse agente. É a mesma regra da campanha de saída: vale
enquanto a conversa existir, em todo turno, e só para a conversa em que a frase
casou — a próxima conversa do mesmo contato volta à régua do número, e trocar o
agente no meio do atendimento continua sendo uma ação explícita.

Campanha sem agente declarado, agente arquivado ou sem versão publicada, e
contato que não veio de anúncio continuam exatamente como antes. E a régua de
elegibilidade segue na frente: dono humano, `force_human`, "sempre atendimento
humano" e bot silenciado barram o turno antes de o agente da campanha ser
consultado.
