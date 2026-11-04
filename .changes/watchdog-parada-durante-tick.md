---
impacto: correcao
secao: corrigido
titulo: O watchdog respeita a parada durante a reconciliação
---
O sinal de desligamento chega também à reconciliação de sessões e é conferido depois das leituras, antes de iniciar outro efeito. Preserva a conclusão dos efeitos já iniciados e as regras atuais de retomada, telefone adicional e supressão de escritas sem mudança. Crédito: @vagnerrm122.
