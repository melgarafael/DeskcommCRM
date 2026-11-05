---
impacto: capacidade_nova
secao: adicionado
titulo: Follow-up de etapa pode sair mesmo com a conversa atribuída a uma pessoa
---

O follow-up de etapa parava de chegar quando a conversa já estava com um
vendedor: assumir, atribuir ou transferir cala a IA na conversa, e a política de
handoff do fluxo tratava isso como "alguém está no comando" — numa instalação
real, **de 28 inscrições só 2 clientes receberam algo e 7 foram canceladas** com
o motivo `pessoa_no_comando` já na primeira mensagem.

Cada fluxo de follow-up ganhou a opção "enviar mesmo com a conversa atribuída a
uma pessoa", desligada por padrão. Ligada, os passos de texto do fluxo saem
quando a única barreira é a posse da conversa. Ela **não** vence o handoff
pedido pela IA ou pelo cliente, o "sempre atendimento humano", etiqueta de
contato interno, contato bloqueado, opt-out nem as janelas de horário — e não
acorda a IA: a resposta automática na conversa com dono continua barrada.
