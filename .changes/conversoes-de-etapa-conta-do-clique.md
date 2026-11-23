---
impacto: exige_acao
secao: corrigido
titulo: Conversões de etapa só seguem para a conta do Google Ads que originou o clique
---

Quando um negócio muda de etapa, o CRM compara a conta do clique registrado naquele negócio com a conta de anúncios configurada para receber a conversão. Se o clique não informar um ID válido ou pertencer a outra conta, o motivo do envio ignorado aparece no histórico de conversões. Contribuição de @SerusoNakamoto.

## Requer atenção

Se você envia conversões de etapa, inclua nos links dos anúncios o parâmetro `google_customer_id` com os dez dígitos da conta que veicula cada anúncio. Se o anúncio leva ao seu site, o botão deve repassar esse parâmetro ao link de rastreamento do CRM junto com o identificador do clique. Confira se a conta corresponde à cadastrada em **Configurações → Conversões → Google Ads**. Isso também vale para quem usa uma única conta. O ajuste identifica os cliques futuros. Negócios antigos sem clique e conta registrados no próprio cartão ficam fora do envio, mesmo que a ficha do contato tenha um anúncio de origem.
