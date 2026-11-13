---
impacto: capacidade_nova
secao: corrigido
titulo: O Inbox diz por que a lista não carregou e aguenta a API REST lenta sem perder as conversas na tela
---

Quando a chamada que carrega as conversas estoura o tempo ou o servidor fica fora do ar, o Inbox continuava insistindo sozinho (até três tentativas, com espera crescente) e agora, ao desistir, DIZ o que aconteceu: "a consulta excedeu o tempo limite", "o servidor não respondeu agora" ou "sua sessão expirou" — em vez de "Erro inesperado. Tente novamente.". A tela também avisa que as conversas continuam salvas, e oferece "Tentar novamente" sem recarregar a página, preservando filtro e conversa aberta.

A lista já carregada não desaparece mais quando uma atualização falha: as conversas ficam onde estão.

Pedido inválido (400, 401, 403, 404, 422) não é repetido — repetir um pedido recusado só multiplica o erro. A repetição passou a cobrir também 502 e 504 na LEITURA; em ESCRITA ela continua restrita às respostas em que o servidor diz que nada foi processado (429 e 503), para não duplicar mensagem.

Crédito: @webtecnica.
