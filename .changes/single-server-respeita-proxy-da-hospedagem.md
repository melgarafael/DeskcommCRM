---
impacto: nada_mudou
secao: corrigido
titulo: O instalador single-server deixa de apagar o REVERSE_PROXY escolhido no ambiente
---
O `install-single-server.sh` gravava `REVERSE_PROXY=caddy` fixo no `.env`, e os comandos de `docker compose` do modo single-server nunca incluíam o arquivo do Traefik ou do Nginx Proxy Manager. Agora o valor exportado chega ao `.env` e o arquivo do proxy entra junto. Sem a variável, nada muda: o padrão continua sendo o Caddy do kit. **A instalação single-server atrás de um proxy próprio ainda não conclui**: com Traefik, a fase 2 para com 404 por falta da rota do Supabase (medido na #2099); o Nginx Proxy Manager não foi testado. Isso segue aberto na #2099.

Crédito: #2150 (@webtecnica), construído sobre o diagnóstico de @brunno-soaress na #2099.
