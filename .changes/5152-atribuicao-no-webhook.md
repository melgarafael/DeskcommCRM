---
impacto: capacidade_nova
secao: adicionado
titulo: O webhook de saída leva a origem do anúncio do contato em um bloco attribution
---

Quando o contato tem origem de anúncio gravada, o `contact` do envelope de saída
passa a trazer um bloco `attribution` com uma lista fechada de chaves: `platform`,
`click_id`, `click_source`, `ad_id`, `campaign_id` e `campaign_name`. É o que quem
monta um painel externo (planilha, BI) precisa para cruzar anúncio e campanha com
o lead e a venda sem uma segunda chamada à API por contato.

O bloco é montado dos metadados do próprio contato, na hora da entrega, sem
consulta nova no caminho do webhook. Cada chave só aparece quando existe: um
contato que só tem `ad_platform` recebe só `platform`, e um contato sem origem
sai exatamente como antes, sem `attribution`. O `source_metadata` cru nunca é
repassado — `fbc`, `fbp` e o payload bruto do transporte ficam fora do envelope.
Os nomes oficiais de campanha, conjunto e anúncio continuam nas rotas
`GET /api/v1/contacts/{id}` e `GET /api/v1/contacts/{id}/hierarquia-do-anuncio`;
o guia de webhooks de saída foi atualizado com o exemplo do bloco e as regras.

Contribuição de @webtecnica, a partir da issue #5152.
