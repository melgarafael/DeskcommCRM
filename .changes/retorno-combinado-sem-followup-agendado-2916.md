---
impacto: nada_mudou
secao: corrigido
titulo: Com casos ligados, o agente deixa de combinar um retorno que não agendou
---

O agente às vezes confirmava ao cliente um retorno combinado sem deixar nada agendado: o cliente pedia "pode ser daqui a duas horas", o agente respondia "Combinado, retomamos daqui a duas horas." e nenhuma ferramenta era chamada naquele turno. O cliente ficava esperando uma mensagem que não vinha. Medido pelo autor da issue, no mesmo cenário, em 3 de 11 execuções.

O gate que existe para isso — o mesmo que barra a promessa de envolver um humano sem abrir o caso — já libera a promessa de retorno do próprio assistente quando o agendamento do follow-up foi feito de verdade no turno. O problema era o único sinal que marcava essa promessa: ele vinha do classificador semântico, que é um modelo e não reconhecia "retomamos daqui a duas horas" de forma confiável. A frase não nomeia ninguém da equipe, então nem o léxico de promessa-de-humano nem a pergunta semântica a apanhavam.

Agora o gate lê também um detector léxico determinístico, sem chamada de modelo: a frase em que o próprio assistente se compromete a retomar a conversa mais adiante ("retomamos daqui a duas horas", "volto a falar com você", "te chamo mais tarde"). "Retomo", "retomamos" e "vou retomar" só contam como promessa quando o quando vem colado ao verbo ("retomamos daqui a duas horas", "vou retomar o contato na segunda", "amanhã retomamos"). Retomar a conversa agora, no próprio turno, não conta quando o dia ou a hora são o assunto e não vêm colados ao verbo ("Vamos retomar o agendamento: prefere segunda ou terça?"). Sem o retorno agendado no turno, a mensagem é vetada e o modelo é instruído a agendar antes de confirmar — ou a reformular sem prometer. O vocabulário é mínimo de propósito e foi medido contra as falas legítimas do repertório e contra retomadas imediatas com dia e hora no assunto: nenhuma das medidas é vetada por ele. A promessa de retorno de conteúdo ("te retorno com a proposta") continua sendo do classificador semântico, como era.

Vale para os agentes com casos ligados, porque é o gate de casos que faz a verificação. Com casos desligados, que é o padrão de um agente novo, a frase ainda sai sem essa verificação; isso segue aberto na issue #2916.

Nenhuma configuração nova, nenhum passo manual.

Contribuição de @webtecnica (#2928), a partir da issue #2916.
