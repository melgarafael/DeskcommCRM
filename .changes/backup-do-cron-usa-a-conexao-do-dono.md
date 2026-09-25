---
impacto: nada_mudou
secao: corrigido
titulo: O backup diário do banco usa a conexão do dono, e não sai mais incompleto
---

O `scripts/backup-db.sh` (o backup que a documentação manda pôr no cron) agora usa a conexão do dono do banco (`SUPABASE_DB_ADMIN_URL`) quando ela existe, com a conexão do app como reserva — a mesma ordem que o backup do kit já seguia. Antes, numa instalação com role de app menor, o dump salvava só o que essa role enxergava e terminava sem erro. Quem tem só `SUPABASE_DB_URL` não precisa fazer nada: o backup continua igual. Contribuição de @hiro-nikaitou (#1637).
