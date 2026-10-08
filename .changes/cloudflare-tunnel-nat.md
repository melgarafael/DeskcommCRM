---
impacto: capacidade_nova
secao: adicionado
titulo: VPS atrás de NAT publica o CRM pelo Cloudflare Tunnel, com o Caddy desligado
---

Instalação atrás de NAT (ou CGNAT, ou rede que proíbe entrada) não conseguia
publicar: o Caddy não obtém certificado sem as portas 80/443 alcançáveis de fora,
e o domínio não abria. Agora o `.env` aceita `REVERSE_PROXY=cloudflared`: entra o
`docker-compose.cloudflared.yml`, o Caddy fica desligado e um contêiner
`cloudflared` abre a conexão de saída para a borda da Cloudflare. Nenhuma porta
de entrada é necessária, e a configuração do túnel (hostnames, TLS) mora no painel
da Cloudflare — no `.env` fica só `CLOUDFLARE_TUNNEL_TOKEN`. O instalador e o
`update.sh` escolhem o override sozinhos a partir de `REVERSE_PROXY`.

Dois pontos a saber. O webhook global do WAHA (`/api/v1/webhooks/waha`) deixa de
receber o 403 que o Caddy dava e precisa de uma regra de WAF/Access na Cloudflare
(o HMAC continua valendo). E este modo não é suportado no single-server, onde as
APIs do Supabase dependem do Caddy — o instalador recusa com instrução.

Contribuição de @caiofacchinato.
