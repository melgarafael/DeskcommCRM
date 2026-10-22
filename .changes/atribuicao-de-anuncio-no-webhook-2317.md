---
impacto: capacidade_nova
secao: adicionado
titulo: Lead de formulário passa a guardar de qual anúncio veio
---
Quem anuncia para uma landing page com formulário não tinha a origem do anúncio no contato: `fbclid`, `fbc`, `fbp`, `gclid`, `ad_id`, `adset_id` e `campaign_id` chegavam no webhook de captação e viravam campo personalizado do card, como se a pessoa os tivesse preenchido — e a venda fechada depois não sabia a qual clique reportar. Agora, quando o formulário manda essas chaves no topo do envio (o formato genérico do webhook de captação), elas são **reservadas**: saem do card e vão para os metadados de origem do contato. Envios no formato do Elementor, do RD Station e do Respondi ainda não são lidos por este caminho. A atribuição é gravada pela mesma regra de primeiro toque que o anúncio clique-para-WhatsApp já usa (`fn_estampar_atribuicao_de_anuncio`) — sem automação própria para mandar a conversão. O clique decide a plataforma: `fbclid`/`fbc` gravam a atribuição da Meta, `gclid` a do Google. Se a sua integração lia alguma dessas sete chaves como campo do lead, ela deixa de aparecer no card e passa a ficar na origem do contato. — webtecnica
