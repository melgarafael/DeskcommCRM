---
impacto: nada_mudou
secao: corrigido
titulo: A conversa que nenhum agente vai responder deixa de aparecer como "Automático atendendo"
---

O comando da conversa (`comando_da_conversa`, exposto pelo PostgREST) respondia
só pelo estado da conversa: sem dono e sem trava, ele dizia `automatico` mesmo
quando nenhum agente podia respondê-la — a organização tem agente publicado em
outro número, ou o canal está em pré-go-live e o contato está fora da lista de
teste. A conversa ficava fora da Fila, a troca de carteira a pulava e o dreno do
agente descartava o turno: ninguém a via e ninguém respondia.

Agora o `automatico` só vale quando há, de fato, quem atenda aquele número: a
mesma régua que o dreno aplica antes de gastar (agente publicado na conexão, ou
roteador ativo com membro/fallback publicado — sem os pausados) mais o portão de
pré-go-live do canal, com o nono dígito comparado nas duas direções. Onde não há
quem atenda, o comando é `aguardando`: a Fila mostra e a carteira leva.

Não muda nada onde já havia quem atendesse; conversa com dono, encerrada, grupo e
conversa calada continuam como estavam. Nada a fazer na instalação.
