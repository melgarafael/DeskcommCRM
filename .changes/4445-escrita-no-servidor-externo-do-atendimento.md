---
impacto: capacidade_nova
secao: adicionado
titulo: A IA pode alterar dados no sistema externo durante o atendimento, ferramenta por ferramenta
---

Até agora, quando um agente de IA usava um servidor MCP externo (o ERP, a agenda,
o sistema de reservas da empresa) durante uma conversa, ele só conseguia
consultar. Ferramenta de escrita ficava recusada, e a conversa parava no humano
justamente no passo que dependia do sistema de fora — concluir a reserva,
cancelar o pedido, remarcar o horário.

Agora o administrador pode liberar a escrita. A liberação é uma **lista**, não um
interruptor: em Configurações › Servidor MCP externo há dois campos, um para toda
conexão MCP da empresa e outro só para o servidor compartilhado, e neles se
escreve o nome exato de cada ferramenta que pode alterar dados — uma por linha.
O que não estiver na lista continua recusado, com uma resposta que diz ao modelo
qual ferramenta não está liberada e em qual conexão, para ele concluir o resto e
passar à equipe o que falta, em vez de repetir a chamada. Curinga (`*`, `all`,
`todos`) não é aceito: liberaria também as ferramentas que o servidor ainda nem
anuncia.

A liberação **nasce vazia**: instalação que não configurar nada continua
consultando e não altera nada, como antes. Se o sistema de fora cair, demorar ou
recusar, o atendimento não cai junto — a IA recebe o aviso, não confirma ao
cliente o que não foi confirmado e a conversa segue. Cada escrita fica na
auditoria com a ferramenta, a conexão, a conversa, os argumentos resumidos e o
desfecho (`ok`, `negado` ou `erro_externo`); o conteúdo enviado não é guardado.
Contribuição de @webtecnica (#4445).
