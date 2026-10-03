---
impacto: nada_mudou
secao: corrigido
titulo: No número oficial intermediado, o pino que chegou sem coordenadas é recuperado sozinho
---

Quando o cliente manda a localização pelo WhatsApp, o sistema pede as
coordenadas à API do canal. Se a API não respondia a tempo, a mensagem ficava
para sempre como «📍 Location», sem mapa na conversa e sem link para quem
entrega. Agora o sistema tenta de novo depois de 1 minuto, e a cada 2 minutos
até 15 minutos; quando consegue, a mensagem passa a mostrar o mapa (e, com a
chave de Mapas, a rua e a cidade aproximadas), como se tivesse chegado assim.
