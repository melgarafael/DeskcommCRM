---
impacto: nada_mudou
secao: corrigido
titulo: A atualização para quando o banco não recebe a versão nova, em vez de dizer que deu certo
---

Quando a atualização do banco terminava com um erro que tentar de novo não resolve (o caso comum é a conexão do `.env` não ser a dona do banco: `permission denied` ou `must be owner`), o `update.sh` avisava no meio da saída e seguia: trocava o app pela versão nova por cima de um banco pela metade e terminava com sucesso. Na atualização automática ninguém via o aviso. Agora a atualização para nesse ponto, depois de conferir as regras de isolamento. O app segue na versão anterior, a tela registra a rodada como falha e o log diz o que fazer: num Supabase próprio, declarar `SUPABASE_DB_ADMIN_URL` no `.env` e repetir com `bash hostgator-setup-kit/update.sh --to <versão> --force`. Quem tem a conexão dona do banco não vê diferença. Disputa com o banco ocupado continua sendo repetida e aceita como antes.

Contribuição de @hiro-nikaitou (#1640).
