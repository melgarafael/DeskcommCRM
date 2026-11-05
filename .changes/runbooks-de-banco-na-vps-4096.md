---
impacto: nada_mudou
secao: corrigido
titulo: Runbooks de banco passam a mostrar o comando que funciona na VPS
---

Os guias de diagnóstico do Supabase (compute insuficiente, cota/egress e replay do gateway) mandavam rodar `psql "$SUPABASE_DB_URL"` direto na VPS. A instalação do kit não instala cliente de Postgres, então o comando morria em `psql: command not found` — e `docker compose -f docker-compose.prod.yml` rodado fora da pasta da instalação morria em `no such file or directory`. Quem estava com o sistema fora do ar ficava sem o diagnóstico que o guia prometia.

Agora esses runbooks (e mais dois que pediam o mesmo) abrem com três linhas que se copiam e colam: achar a pasta da instalação, carregar a connection string do `.env` e rodar as consultas com o `psql` do contêiner `postgres:17-alpine`, o mesmo que o instalador já usa. O passo de diagnóstico é o mesmo — mudou o **como**, não o **que** olhar. Quem prefere o painel tem o caminho pelo SQL Editor, e quem tem `psql` na máquina continua podendo usá-lo.

Você não precisa mudar nada.
