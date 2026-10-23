---
impacto: capacidade_nova
secao: adicionado
titulo: Mensagem apagada fica cinza, diz quem apagou, e o apagamento pelo aplicativo entra na auditoria
---
Quando alguém apaga uma mensagem ("apagar para todos"), a bolha agora sai das cores da direção e vira **cinza**, com o marcador dizendo **quem** apagou: o contato ou o atendente. Antes, a única diferença era uma opacidade. A **auditoria** passa a registrar também quem apaga pelo aplicativo do WhatsApp (o contato, ou o próprio número da empresa pelo celular), que não deixava rastro nenhum. O apagar feito pela tela do CRM segue registrado como antes, com quem apagou. O aviso que o WhatsApp devolve desse apagar não gera um segundo registro quando chega depois de o CRM marcar a mensagem como apagada, e um aviso repetido pelo WhatsApp também não. Se o aviso chegar antes dessa marcação, pode sair um registro a mais, atribuído ao celular da empresa (raro, e ainda não medido). A trilha guarda o EVENTO, nunca o corpo: `api_audit_log` é append-only, com retenção de 5 anos, e sobrevive ao apagamento da organização. Quem vê o texto apagado continua como antes: o do contato não aparece, o do atendente segue visível à equipe só no CRM, e o PDF da conversa não traz nenhum dos dois.

Contribuição de @webtecnica (#3279).
