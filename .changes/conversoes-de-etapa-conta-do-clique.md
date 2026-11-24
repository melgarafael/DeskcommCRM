---
impacto: exige_acao
secao: corrigido
titulo: Conversões de etapa do Google Ads usam o clique do próprio negócio
---

Quando um contato volta por outro anúncio, cada negócio usa seu próprio clique para enviar conversões de etapa ao Google Ads. Com uma única conta cadastrada, o CRM mantém o envio para ela mesmo que o clique não informe a conta ou identifique outra. Com várias contas, o clique precisa identificar a conta de envio. Se faltar a correspondência, o motivo aparece no histórico. Contribuição de @SerusoNakamoto.

## Requer atenção

Se a sua organização envia conversões de etapa e tem **mais de uma conta do Google Ads cadastrada**, inclua `google_customer_id` no modelo de rastreamento ou no sufixo de URL de cada conta. Use os dez dígitos da conta que veicula o anúncio. Se o anúncio leva ao seu site, o botão deve repassar esse parâmetro junto com o identificador do clique ao link de rastreamento do CRM. O ajuste vale para cliques futuros. Com várias contas, negócios já abertos cujo clique não traz o ID da conta continuam sem enviar a conversão de etapa.
