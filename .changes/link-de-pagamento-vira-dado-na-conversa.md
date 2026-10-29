---
impacto: capacidade_nova
secao: adicionado
titulo: O link de pagamento colado na conversa vira registro, e o aviso de "pago" da InfinitePay fecha o negócio sozinho
---

Antes, o vendedor colava na conversa o link de pagamento da InfinitePay e depois precisava conferir no extrato se o cliente pagou, para então mover o negócio à mão. Agora o link enviado pode ser registrado na conversa (pela API, em `POST /api/v1/conversations/{id}/pagamentos`), com valor e situação "pendente". Quando a InfinitePay avisa que o cliente pagou, o registro passa a "pago" e o negócio é marcado como ganho pelo mesmo caminho do botão "Marcar como ganho": se o funil exige algum campo ou o motivo do ganho para fechar, o pagamento fica registrado, o negócio não anda, e a linha do tempo do negócio diz o que falta. Aviso repetido não marca nada duas vezes. Registrar o link e confirmar o pagamento entram no registro de auditoria. Para ligar, cole em Painel › Cobrança o segredo dos avisos de pagamento da InfinitePay, o mesmo cadastrado lá; sem ele, todo aviso é recusado e nada muda nos negócios. Quem não usa InfinitePay não vê diferença.
