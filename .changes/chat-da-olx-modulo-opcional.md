---
impacto: capacidade_nova
secao: adicionado
titulo: O chat da OLX pode entrar no Inbox, como módulo opcional e desligado de fábrica
---

Quem tem plano profissional na OLX pode receber e responder pelo Inbox as
mensagens de quem chamou pelo anúncio. A conversa aparece como OLX, o negócio
nasce com origem OLX, e o que o vendedor responde pelo app da OLX também aparece
na conversa e pausa a IA, como nos outros canais. Só texto, nos dois sentidos.
Campanha não sai por este canal.

O canal vem desligado. Desligado, não há rota de conexão nem entrada de
mensagens. Para ligar, ponha `OLX_ENABLED=true` no `.env` e reinicie o app; quem
não liga não precisa mexer em nada. A OLX não assina o que entrega: a entrada
confia num código secreto e único por conexão, no endereço HTTPS do webhook.
Contribuição de @webtecnica, a partir do pedido de @brunno-soaress.
