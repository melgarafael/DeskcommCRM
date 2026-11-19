---
impacto: capacidade_nova
secao: adicionado
titulo: O túnel da Cloudflare pode ficar fixo em http2 quando o provedor bloqueia UDP
---

Em instalações atrás do Cloudflare Tunnel (`REVERSE_PROXY=cloudflared`), o túnel tenta sempre o protocolo QUIC primeiro, que usa UDP. Em VPS cujo provedor descarta UDP de saída, cada reconexão passava minutos falhando antes de cair para http2, e o painel da Cloudflare marcava o túnel como "degraded" nessa janela. Agora dá para pôr `CLOUDFLARED_PROTOCOL=http2` no `.env` e o túnel conecta direto por http2. Sem a variável, nada muda: o padrão continua `auto`. Como confirmar se é o seu caso está em `docs/runbooks/deploy.md`, seção 5.
