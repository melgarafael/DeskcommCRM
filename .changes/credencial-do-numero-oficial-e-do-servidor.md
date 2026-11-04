---
impacto: nada_mudou
secao: corrigido
titulo: A credencial do número oficial passa a ser gravada só pelo servidor
---

O número, a conta e o token do canal oficial da Meta (`meta_phone_number_id`,
`meta_waba_id` e `meta_token_encrypted` em `channel_sessions`) passam a ser
gravados só pelo servidor, como a ligação com o provedor parceiro desde a
migration 9093. Conectar e excluir o canal oficial pela tela continua igual: as
duas rotas já gravavam pelo servidor, e a exclusão passa a zerar o token pelo
mesmo caminho. Renomear a conexão continua liberado para o admin.

Migration 9104, aplicada pelo `update.sh` como as demais. Nada a fazer.
