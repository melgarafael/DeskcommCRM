---
impacto: nada_mudou
secao: corrigido
titulo: A frase da opção de parar volta a sair inteira quando a abordagem vai em várias mensagens curtas
---

Na campanha de prospecção com "Responder em várias mensagens curtas" ligado, a frase que ensina a pessoa a parar de receber (a padrão ou a escrita pela empresa) é um parágrafo próprio e sai na última mensagem da resposta. Dois caminhos a perdiam: o reenvio automático de uma mensagem que ficou na fila do canal lia só a primeira bolha e mandava a resposta sem a frase; e, quando o teto de caracteres da bolha era menor que a frase, ela era cortada em duas e o sistema deixava de amarrar a saída à mensagem que a carregava, oferecendo a saída de novo depois. Agora a frase sai inteira uma vez, e a saída continua presa à mensagem certa — inclusive quando o assistente manda mais de uma mensagem na mesma resposta: o reenvio lê só as mensagens daquele envio, então não perde a frase nem repete o pedido de parar. Nada a fazer na VPS.
