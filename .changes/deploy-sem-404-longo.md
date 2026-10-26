---
impacto: nada_mudou
secao: alterado
titulo: Atrás do Traefik da hospedagem com Docker antigo, a atualização deixa o domínio fora do ar por segundos, não por meio minuto
---

Em servidores com o Traefik da hospedagem na frente (Hostinger, Coolify,
Dokploy) e Docker 24 ou mais antigo, o domínio respondia "404 page not found"
por 30 a 45 segundos depois de uma atualização, mesmo com o sistema já
pronto: a checagem de saúde que libera o tráfego só rodava a cada 30 segundos.
Ela passa a rodar a cada 10 segundos, e a janela cai para cerca de 10
segundos. Com Docker 25 ou mais novo, ou com o Caddy padrão do kit, nada muda.
O tempo para declarar o sistema fora do ar continua o mesmo, e nada muda na
versão do Docker que o servidor precisa. Obrigado, @jmpo.
