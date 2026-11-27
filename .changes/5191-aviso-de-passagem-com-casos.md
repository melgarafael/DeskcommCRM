---
impacto: nada_mudou
secao: corrigido
titulo: Com casos humanos ligados, o aviso da passagem para a equipe sai pelo sistema e deixa de abrir caso duplicado
---

Quando o agente tem casos humanos ligados, a ferramenta de passagem mandava o modelo avisar o cliente antes ("vou chamar alguém da equipe") — e o guardrail que impede prometer humano sem caso aberto vetava exatamente esse aviso. O modelo obedecia à ferramenta e era barrado; na segunda tentativa, o sistema abria um caso humano além da passagem, os dois para o mesmo atendimento.

Agora, com casos ligados, a descrição da ferramenta diz para **não** escrever o aviso: o modelo chama a passagem e encerra o turno, e o sistema avisa o cliente com a frase do aviso de passagem (a mesma configurável em "Frase do aviso de passagem"). Se o modelo ainda escrever a promessa sem chamar a passagem, o guardrail continua barrando a mensagem — prometer sem chamar deixaria o cliente esperando alguém que ninguém avisou —, mas agora a orientação ao modelo é chamar a passagem, e não abrir um caso. O fail-safe do guardrail também deixa de abrir caso quando a passagem explícita está disponível. Sem a ferramenta de passagem no agente, nada muda: a promessa de humano continua vetada e o caso continua sendo a saída.

Quem usa o agente sem casos humanos não vê diferença: o texto da ferramenta e o comportamento do guardrail continuam iguais. Nada a fazer na atualização. Contribuição de @webtecnica, a partir da issue #5191.
