---
impacto: capacidade_nova
secao: corrigido
titulo: Quando a resposta da IA é barrada de novo na correção automática, a equipe recebe um caso em vez de o cliente ficar sem resposta
---

Quando o turno termina sem nenhuma mensagem ao cliente, o agente recebe uma
correção automática. Se as regras de segurança barravam a resposta e barravam
de novo a que a correção tentou mandar, o turno acabava calado: nenhuma
mensagem saía e nada aparecia para a equipe, porque o aviso final tratava
qualquer tentativa barrada como «o veto já ensinou».

Agora, com casos humanos ligados no agente, o turno abre um caso para a equipe
quando a correção tentou responder e nada saiu, ou quando ela gastou todas as
etapas em consultas sem chegar a responder. O caso diz o motivo em português na
tela da equipe e o lead vai para a etapa de atendimento humano, como nos outros
avisos automáticos.

Continua sem caso o silêncio que o próprio agente escolhe na correção, e o
silêncio pedido pelo contato (descadastro, contato interno, conversa com a
equipe, LGPD). Com casos desligados, a falha segue registrada no log do turno.
