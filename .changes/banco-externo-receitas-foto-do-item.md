---
impacto: capacidade_nova
secao: adicionado
titulo: O assistente manda a foto do imóvel ou produto achado no banco conectado
---

As receitas prontas do banco externo (WooCommerce, imóveis com ACF, imóveis com JetEngine e tabela direta) agora devolvem também o endereço da foto do item, quando existe. Ao apresentar um item ao cliente no WhatsApp, o assistente manda a foto junto, com o texto como legenda, no mesmo envio. Item sem foto continua aparecendo normalmente.

Na tabela direta, o administrador escolhe qual coluna guarda o endereço da foto; no JetEngine, o campo de imagem pode guardar o endereço ou o número do anexo.

Por segurança, só vale a foto que a própria consulta devolveu naquela conversa, o endereço passa pela mesma proteção de rede dos demais envios, e o download tem limite de tempo (8 segundos), de tamanho (5 MB) e de tipo (JPEG, PNG ou WebP). Se a foto não puder ser baixada ou enviada, a mensagem de texto sai do mesmo jeito. Os limites ainda não foram medidos contra o WhatsApp real.

Não muda nada para quem não usa o módulo `banco_externo`.
