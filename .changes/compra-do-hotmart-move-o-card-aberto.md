---
impacto: capacidade_nova
secao: adicionado
titulo: A compra aprovada do Hotmart move o card aberto do comprador no funil
---

Quem vende pelo **Hotmart** agora fecha o funil sozinho: o aviso de compra
(webhook 2.0.0) passa a ser lido de verdade pela captação, e a compra aprovada
alcança o card que a conversa já tinha aberto para aquele comprador.

Antes, o aviso chegava e era recusado com "Nenhum campo mapeável": nome,
telefone e e-mail do comprador vêm dentro de blocos (`data.buyer`), e a captação
só olhava as chaves do primeiro nível do corpo. O resultado era o funil com a
oferta feita e a etapa de ganho vazia.

Agora a captação reconhece o formato do Hotmart pelos caminhos que a própria
plataforma declara — `data.buyer.name`, `data.buyer.email`,
`data.buyer.checkout_phone` com o DDD em `checkout_phone_code` —, casa o
contato por telefone ou e-mail e, na fonte que tem *Reaproveitar o card aberto
do contato* ligada, atualiza esse card e o leva para a etapa da fonte. O cartão
mostra também a transação, o status, o produto, a oferta e o preço da compra.
Comprador de fora do Brasil tem o telefone internacional reconhecido.

O que ficou de fora: o produto não passa a falar com a API do Hotmart, não cria
assinatura e não lê o endereço completo do comprador — só o país, para entender
o telefone. Nenhuma fonte de webhook que já existia muda de comportamento: os
formatos antigos (formulário plano, Elementor, RD Station e Respondi) continuam
sendo lidos como antes, e há caso de regressão para cada um.
