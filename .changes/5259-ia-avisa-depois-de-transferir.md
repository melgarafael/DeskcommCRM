---
impacto: nada_mudou
secao: corrigido
titulo: Depois de transferir a conversa para um atendente, a IA volta a conseguir avisar o cliente
---

Desde a 1.125.0, quando o agente transferia a conversa com `crm_assign_conversation`, a mensagem seguinte dele ao cliente era recusada como "uma pessoa da equipe assumiu esta conversa". O cliente ficava sem o aviso de transferência e sem resposta. Agora a atribuição feita pelo próprio agente no mesmo turno não conta como uma pessoa assumindo, e o aviso sai. Se uma pessoa trocar o dono depois ou já tiver escrito ao cliente, a IA continua sem enviar. A partir do turno seguinte, a conversa fica com o atendente, como antes. O classificador de promessas também deixa de ler o anúncio de transferência ("vou transferir você para a Andreia, que continua seu atendimento por aqui") como promessa comercial. Crédito: @aerosuiteapp.
