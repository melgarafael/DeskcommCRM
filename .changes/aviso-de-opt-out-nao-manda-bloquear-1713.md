---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de suspeita de opt-out na Central para de mandar a equipe bloquear o contato à mão
---

Quando o cliente pedia para parar de receber mensagens com uma frase ambígua ("me deixa em paz", "para de me mandar isso"), o turno silenciava a IA e abria um item na Central que mandava CONFIRMAR, NO CRM, O BLOQUEIO DO CONTATO. Essa ação não existe no produto: o único caminho que bloqueia um contato é o STOP do próprio cliente na entrada da mensagem (`lib/channels/pos-entrada.ts`), e a ficha do contato só oferece Desbloquear. Quem seguisse o aviso procuraria um botão que não está na tela, com a IA calada e o cliente esperando.

O título dos dois caminhos que abrem esse aviso — o modo assistido e o automático — passa a descrever só o que a equipe consegue fazer hoje: assumir a conversa e pedir ao cliente a palavra que a regra reconhece (PARAR, STOP ou SAIR, sozinha na mensagem). O motivo gravado e a passagem do atendimento não mudaram. O botão de bloqueio manual é a decisão DEC-013 e fica fora deste ajuste.

Nada a fazer na atualização.

Contribuição de @webtecnica (#3300).
