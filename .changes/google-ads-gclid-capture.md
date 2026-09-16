---
impacto: capacidade_nova
secao: adicionado
titulo: Landing page de captura de clique do Google Ads
---

Até aqui, uma organização que anunciava no Google Ads não tinha como saber
quais leads do WhatsApp vieram de qual clique pago — o Google Ads, ao
contrário da Meta, não tem um "Clique para o WhatsApp" nativo que carregue
essa informação para dentro da conversa.

Agora existe uma landing page (`/api/v1/anuncios/google/<organização>`) que
recebe o clique do anúncio, gera um código curto e redireciona para o
WhatsApp com esse código já embutido no texto da mensagem. Quando a pessoa
manda a mensagem, o sistema reconhece o código e carimba o contato com a
origem do anúncio — o mesmo carimbo que já existe para a Meta.

Não muda nada para quem já usa o produto: a captura só funciona para a
organização que configurar seu número de WhatsApp e o texto da mensagem em
`google_ads_landing_pages` (ainda sem tela própria nesta versão). O passo
seguinte — reportar a venda de volta para o Google Ads — continua fora do ar,
porque depende de credenciais da API do Google Ads que a maioria das
instalações ainda não tem.
