---
impacto: nada_mudou
secao: corrigido
titulo: Runbooks de banco passam a mostrar o comando que funciona na VPS
---

Os guias de diagnóstico do Supabase (compute insuficiente, cota/egress e replay do gateway) mandavam rodar `psql "$SUPABASE_DB_URL"` direto na VPS. A instalação do kit não instala cliente de Postgres, então o comando morria em `psql: command not found` — e `docker compose -f docker-compose.prod.yml` rodado fora da pasta da instalação morria em `no such file or directory`. Quem estava com o sistema fora do ar ficava sem o diagnóstico que o guia prometia.

Agora esses runbooks (e mais dois que pediam o mesmo) abrem com um bloco curto que se copia e cola: acha a pasta da instalação e roda as consultas pelo mesmo `psql` em contêiner que o instalador já usa, com o `.env` lido pelo próprio kit (senha com caractere especial e instalação single-server incluídas). O passo de diagnóstico é o mesmo — mudou o **como**, não o **que** olhar. Quem prefere o painel tem o caminho pelo SQL Editor, e quem tem `psql` na máquina continua podendo usá-lo.

Você não precisa mudar nada.
