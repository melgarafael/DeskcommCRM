---
impacto: capacidade_nova
secao: adicionado
titulo: Quem publica o CRM atrás de um Nginx Proxy Manager sobrevive a atualizações
---

Instalações que já tinham um Nginx Proxy Manager nas portas 80/443 (em vez do
Caddy do próprio kit, ou de um Traefik) precisavam plugar o contêiner `app` na
rede do NPM à mão (`docker network connect`). Isso sumia na primeira
atualização: `update.sh` recria o `app`, a conexão manual se perde, e o
domínio volta a responder 502 — foi o que aconteceu numa VPS real em
2026-09-11.

Agora `REVERSE_PROXY=npm` no `.env` (junto de `PROXY_NETWORK_NAME` e
`PROXY_NETWORK_APP_IP`, se a rede ou o IP do seu Proxy Host não forem os
padrões) mantém o `app` sempre na rede certa, entra automaticamente em toda
atualização e no cron de auto-update, e nunca sobe o Caddy por engano por
cima do NPM. Se a rede do NPM sumir (`docker network prune`, por exemplo), a
atualização para com uma mensagem explicando o que fazer, em vez de travar no
erro opaco do Docker.

Configurar pela primeira vez continua sendo manual — o NPM não anuncia sua
configuração como o Traefik faz por labels — mas está documentado no
cabeçalho de `docker-compose.npm.yml`.
