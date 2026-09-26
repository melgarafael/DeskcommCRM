---
impacto: nada_mudou
secao: corrigido
titulo: O servidor do app segura a conexão ociosa por mais tempo que o proxy na frente
---

O app fechava a conexão ociosa com o proxy (Caddy ou Traefik) aos 6 segundos, enquanto o proxy
a guardava por até 2 minutos para reaproveitar. Quando a próxima requisição saía no instante
em que o app fechava, ela morria no meio e a pessoa via um erro 502 raro e sem explicação —
um salvamento podia falhar e dar certo ao tentar de novo. Agora o app segura a conexão por
125 segundos, e quem fecha primeiro é sempre o proxy. Nada a fazer: vale ao atualizar.
