---
impacto: nada_mudou
secao: corrigido
titulo: Quando o canal recusa a resposta da IA, ela não é reenviada em laço
---

Quando uma rede social recusava a resposta da IA (por exemplo um áudio que o
provedor não aceita), o sistema tentava o atendimento inteiro de novo, várias
vezes, e cada tentativa deixava mais uma mensagem com falha na conversa do
cliente.

Agora a falha de envio diz se é definitiva ou passageira. Recusa definitiva do
provedor (um erro 4xx, como o 400 de formato, ou a conta que precisa ser
reconectada) encerra o atendimento daquela mensagem sem nova tentativa, a IA não
manda mais nada naquele turno, e a equipe recebe um aviso na Central com o link
para a conversa — o motivo exato fica na própria mensagem que falhou. Falha
passageira (provedor fora do ar, rede) continua sendo tentada de novo como
antes. Hoje a classificação vale para as redes sociais e para o WhatsApp
intermediado; nos outros canais toda falha segue passageira, como sempre foi.
Crédito: @lebaneseforas-byte.
