---
impacto: nada_mudou
secao: corrigido
titulo: A queda da assinatura registra o erro que a causou, além do erro da reserva
---

Quando a assinatura do ChatGPT recusava o turno e a chamada caía na reserva, o
registro da chamada guardava só a falha da reserva — e o aviso no log dizia
apenas que a chamada tinha caído, sem status nem mensagem. Quem investigava lia
"chave de API inválida" e trocava a chave errada. Agora a linha da chamada e o
log trazem as duas falhas, cada uma com o seu lado nomeado (assinatura e
reserva), com o status HTTP e a mensagem já sem segredo. O turno continua com o
mesmo comportamento: uma única tentativa na reserva. Refs #4610.
