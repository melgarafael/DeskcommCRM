---
impacto: capacidade_nova
secao: adicionado
titulo: O clique do anúncio também chega à atribuição pelo Elementor, RD Station e Respondi
---
A atribuição de anúncio do lead de formulário, que até aqui só valia para o envio no formato genérico do webhook de captação, passa a valer também para os envios no formato do Elementor, do RD Station e do Respondi: `fbclid`, `fbc`, `fbp`, `gclid`, `ad_id`, `adset_id` e `campaign_id` vão para a origem do contato, pela mesma regra de primeiro toque. No Elementor e no Respondi elas deixam de aparecer no card como campo preenchido; no RD Station, que antes as ignorava, passam a ser lidas.

Na mesma linha, a venda de um lead de formulário que **não tem telefone** deixa de ser recusada quando o envio trouxe `fbc`/`fbp` — a identidade que o navegador carrega basta para a Meta reconhecer o cliente. Sem clique, sem `fbc`/`fbp` e sem telefone, a recusa continua igual, com a mesma mensagem no Histórico. Nada a fazer na VPS. — webtecnica
