---
impacto: nada_mudou
secao: alterado
titulo: A atualização deixa o domínio fora do ar por segundos, não por meio minuto
---

Durante uma atualização, o domínio respondia "404 page not found" por 30 a 45
segundos, mesmo com o sistema já pronto: a checagem de saúde que libera o
tráfego só rodava a cada 30 segundos. Ela passa a rodar a cada 10 segundos, e
a janela cai para no máximo 10 segundos. O tempo para declarar o sistema fora
do ar continua o mesmo, e nada muda na versão do Docker que o servidor precisa.
