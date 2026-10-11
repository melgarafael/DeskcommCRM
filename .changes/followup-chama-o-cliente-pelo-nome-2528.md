---
impacto: capacidade_nova
secao: corrigido
titulo: Mensagens de follow-up passam a chamar o cliente pelo nome
---

As mensagens de follow-up de texto fixo e de modelo de mensagem (o texto salvo em Modelos) passam a preencher `{{nome}}`, `{{primeiro_nome}}`, `{{contact.*}}` e `{{lead.*}}` com os dados do contato e do negócio, do mesmo jeito que as automações já faziam. Antes, só `{{volta}}` e `{{voltas}}` eram preenchidos, e o cliente recebia a marcação crua, como "Oi {{primeiro_nome}}". O modelo aprovado do WhatsApp oficial segue a regra própria dele.

Variável sem valor sai da frase junto com o espaço: "Oi {{primeiro_nome}}!" chega como "Oi!" quando o contato não tem nome.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2695), a partir da issue #2528.
