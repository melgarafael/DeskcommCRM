---
impacto: capacidade_nova
secao: adicionado
titulo: A mensagem da campanha pode usar campos personalizados do negócio e do contato
---
O texto da campanha passa a aceitar `{{lead.campo}}`, que vem do negócio mais recente do contato, e `{{contato.campo}}`, que vem do cadastro do contato (o caminho da automação, `{{lead.custom_fields.campo}}`, também funciona). Campo vazio, ausente ou contato sem negócio não manda texto pela metade: a pessoa sai da lista como "Falta um dado que a mensagem usa", e isso aparece na contagem antes de enviar. O valor do campo sai na mensagem exatamente como foi gravado, mesmo que contenha chaves como `{{saudacao}}`. Audiências grandes continuam sendo preparadas: os negócios são buscados em lotes, sem cortar quem tem muitos negócios. Não é preciso fazer nada na instalação. Crédito: @webtecnica (pedido em #2311 por @aleflores35).
