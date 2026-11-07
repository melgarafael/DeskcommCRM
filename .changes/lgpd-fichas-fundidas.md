---
impacto: nada_mudou
secao: corrigido
titulo: Anonimizar um contato alcança também as fichas que foram fundidas nele
---

Ao anonimizar um contato, pelo botão da ficha ou por pedido de LGPD, as fichas que tinham sido juntadas nele passam a ser anonimizadas junto, com as mesmas regras e com a marca de apagamento dos telefones delas. Vale para fichas fundidas em cadeia, e só dentro da mesma organização. A foto de perfil e os anexos dos negócios do contato, inclusive os ligados a ele, saem também, pela fila de remoção de arquivos, inclusive quando a anonimização vem do botão da ficha.

Na atualização, as fichas fundidas em contatos que já estavam anonimizados são anonimizadas uma vez, sem nenhum passo manual. Isso é irreversível, como toda anonimização, e cada ficha alcançada deixa uma linha `lgpd.redact_executed` no registro de auditoria, com quem anonimizou e de qual ficha ela veio.

Nada a fazer na instalação.
