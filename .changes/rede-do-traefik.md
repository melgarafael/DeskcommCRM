---
impacto: nada_mudou
secao: corrigido
titulo: O instalador deixa de escolher a rede do Traefik pela ordem alfabética quando ele está em mais de uma rede
---

Quando o Traefik da hospedagem estava ligado a mais de uma rede Docker, o
instalador escolhia a primeira em ordem alfabética, e não a rede que o painel
usa para os sites.

Agora, havendo mais de uma rede, o instalador usa a `coolify` quando ela está
entre elas. Se não estiver, ele para e lista as redes encontradas, pedindo que
você informe a certa em `TRAEFIK_NETWORK` no `.env`. Quem já declarou
`TRAEFIK_NETWORK` segue igual, e quem já instalou não é afetado por esta mudança.
