---
impacto: nada_mudou
secao: corrigido
titulo: Anonimizar um contato alcança também as fichas que foram fundidas nele
---

Ao anonimizar um contato, pelo botão da ficha ou por pedido de LGPD, as fichas que tinham sido juntadas nele passam a ser anonimizadas junto, com as mesmas regras e com a marca de apagamento dos telefones delas. Vale para fichas fundidas em cadeia, e só dentro da mesma organização. A foto de perfil e os anexos dos negócios de que o contato é o titular saem também, pela fila de remoção de arquivos, inclusive quando a anonimização vem do botão da ficha. Um negócio de outro titular, em que o contato é só pessoa relacionada, mantém os anexos.

Na atualização, as fichas fundidas em contatos que já estavam anonimizados são anonimizadas uma vez, sem nenhum passo manual. Isso é irreversível, como toda anonimização, e cada ficha alcançada deixa uma linha `lgpd.redact_executed` no registro de auditoria, com a ficha de origem. Nessas linhas o autor fica vazio, porque quem as grava é a atualização.

Nada a fazer na instalação.
