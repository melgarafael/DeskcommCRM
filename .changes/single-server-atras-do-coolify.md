---
impacto: capacidade_nova
secao: adicionado
titulo: Instalação com o banco na própria VPS passa a funcionar atrás do proxy do Coolify
---

Quem usa Coolify (ou outro painel cujo proxy roda em rede Docker própria) agora
pode instalar o CRM com o Supabase na mesma VPS. Antes, o banco tentava usar a
porta 8000, que é a do painel do Coolify, e a instalação parava; e o proxy do
painel não alcançava as APIs do banco.

Para usar, exporte a porta do banco e a rede do proxy ao rodar o instalador:
`API_GW_HTTP_PORT=8001 REVERSE_PROXY=traefik TRAEFIK_NETWORK=coolify
TRAEFIK_ENTRYPOINT=https TRAEFIK_ENTRYPOINT_HTTP=http bash
hostgator-setup-kit/install-single-server.sh --domain SEU_DOMINIO`. Passo a
passo medido em docs/saas/coolify.md. Quem instala sem essas variáveis não vê
mudança nenhuma. Construído sobre o #2150 e o #2289 de @webtecnica (issue #2099
de @brunno-soaress).
