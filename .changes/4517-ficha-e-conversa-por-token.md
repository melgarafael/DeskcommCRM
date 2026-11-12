---
impacto: capacidade_nova
secao: adicionado
titulo: Integração por token edita a ficha do cliente e comanda o atendimento sem trocar o responsável
---

Uma integração que atendia o cliente por token tinha duas saídas ruins. Para
corrigir um cadastro, só conseguia pedir revisão: a mudança virava proposta e
esperava alguém abrir o CRM. Para calar o atendimento automático de uma
conversa, o único caminho era transferir — e transferir troca o responsável da
conversa e o do negócio, transformando pausa em tomada de carteira.

Agora existem as duas portas, com escopo próprio, concedido por quem emite o
token na tela de Tokens de API. Na ficha, `contacts:write` grava na hora, com a
mesma régua da tela (documento do país, consentimento, trava de anonimização e
auditoria); sem esse escopo, a edição continua virando proposta, e a resposta
diz isso com o nome do campo que precisa de permissão. No atendimento,
`conversations:write` pausa e retoma a IA e encerra e reabre a conversa: pausar
não assume a conversa sem dono, nem muda o dono do negócio, e retomar não solta
o responsável humano — quando ele existe, a resposta avisa que o automático
segue vetado. Encerrar e reabrir passam pela mesma transição do botão da tela,
com revisão conferida.

As quatro operações também entram no catálogo do agente como ferramentas, para
quem opera o CRM conversando: pausar, retomar, encerrar e reabrir. O próprio
agente não comanda a sua automação — quem pausa é uma pessoa ou uma integração
autorizada. O log de auditoria registra qual token agiu em cada um desses
gestos (#4517).
