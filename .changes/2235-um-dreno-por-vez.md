---
impacto: nada_mudou
secao: corrigido
titulo: A fila de eventos deixa de ser varrida duas vezes por minuto
---

Em instalações com o agendador do contêiner e o cron do servidor ligados ao mesmo tempo, os dois varriam a fila de eventos no mesmo minuto. Agora só um trabalha por vez e o outro sai sem tocar em nada, o que reduz o tráfego com o banco. Nada a configurar.

Crédito: @webtecnica.
