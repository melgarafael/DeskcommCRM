---
impacto: capacidade_nova
secao: adicionado
titulo: Novo módulo opcional Link de pagamento na conversa, desligado de fábrica, em que o aviso de "pago" da InfinitePay fecha o negócio
---

Antes, o vendedor mandava na conversa o link de pagamento da InfinitePay e depois precisava conferir no extrato se o cliente pagou, para então mover o negócio à mão.

Com o módulo **Link de pagamento na conversa** ligado em Administração › Sistema, a atendente registra numa conversa o valor a cobrar (por enquanto pela API, em `POST /api/v1/conversations/{id}/pagamentos`) e recebe um endereço de aviso próprio daquele recebimento. Ela cola esse endereço como "URL do Webhook" ao criar o link na InfinitePay e manda o link ao cliente como sempre. Quando o cliente paga, o aviso marca o recebimento como pago e leva o negócio para ganho pelo mesmo caminho do botão "Marcar como ganho": se o funil exige algum campo ou o motivo do ganho, o pagamento fica registrado, o negócio não anda, e a linha do tempo diz o que falta.

O aviso só vale se trouxer o segredo daquele recebimento e o mesmo valor registrado; aviso repetido não marca nada duas vezes. Não há segredo compartilhado da instalação: cada recebimento tem o seu, e a empresa não precisa configurar chave nenhuma. O endereço só é entregue quando a instalação tem um endereço público https. Registrar e confirmar entram na auditoria.

Desligado (o padrão), ninguém registra recebimento e os avisos são recusados. Quem não liga não vê diferença.

Trabalho original de @webtecnica (#3590), com as medições contra a InfinitePay de @franceschini-lucas e @webtecnica.
