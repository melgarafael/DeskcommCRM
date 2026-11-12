---
impacto: nada_mudou
secao: corrigido
titulo: Automação de WhatsApp para contato que não pode receber é pulada na hora, com o motivo, em vez de esperar a janela de envio
---

Fora da janela de envio do número (7h às 22h, por padrão), as ações "Enviar mensagem de WhatsApp" e "Enviar mensagem escrita pela IA" adiavam o evento antes de olhar o contato. Um contato bloqueado, sem telefone, sem contato no evento ou com recusa de mensagens registrada ficava na aba Atividade como "esperando a janela de envio", e o motivo real só aparecia quando a janela abria.

Agora a guarda do contato vem antes da espera. O contato que a ação recusaria é pulado na hora, com o motivo (`contact_blocked`, `no_phone`, `no_contact`, `consent_declined`). Quem passa na guarda continua esperando a janela do número, como antes: nenhuma mensagem sai fora da janela.

Crédito: @webtecnica, que mediu o defeito e escreveu o conserto (#4467, issue #4365).
