---
impacto: exige_acao
secao: corrigido
titulo: O filtro de palavras do agente passa a valer
---

Na tela do agente, o campo "Só responder quando a mensagem falar de algo específico" era gravado e nunca consultado: o agente respondia a tudo. Agora, no modo automático, a IA não responde a uma mensagem que não tenha nenhuma das palavras configuradas. Isso vale para cada mensagem, inclusive no meio de uma conversa que o agente já começou: se ele perguntou o produto e o cliente respondeu "camiseta azul" sem nenhuma das palavras, essa resposta fica sem retorno (a issue #3142 discute fazer o filtro valer só para a entrada do agente). A mensagem continua na conversa, mas não gera aviso na Central; só a vê quem abrir a conversa. Pedido de atendente, pedido para parar de receber mensagens e áudio ou imagem ainda sem transcrição continuam passando, mesmo sem a palavra. No modo assistido, nada muda.

Fora do horário de funcionamento do agente, pedido de atendente e pedido para parar passam a ser tratados quando a mensagem chega, desde que a janela de envio do número esteja aberta (por padrão, das 7h às 22h). Fora dessa janela, eles esperam ela abrir, como antes.

Corrigido por @webtecnica (#2696), a partir do relato de @FelipeMartini (#2679).

## Requer atenção

Se algum agente seu tem esse campo preenchido, ele vai passar a ficar calado em toda mensagem sem uma das palavras, inclusive no meio da conversa. Antes de atualizar, confira o campo na tela de cada agente. Se não quiser o filtro, deixe-o em branco e publique a versão de novo.
