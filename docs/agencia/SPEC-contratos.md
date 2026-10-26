# Spec: `contratos` — gerar, assinar, receber

> Fase 6 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **decidida** em 26/10/2026
> pelas sugestões (o dono pediu para as fases seguirem sem parar para aprovação).
> Depende de [`clientes`](SPEC-clientes.md), [`whatsapp-agencia`](SPEC-whatsapp-agencia.md),
> [`formulario`](SPEC-cofre-e-formulario.md) e [`trilhas`](SPEC-trilhas.md).

## Objetivo

Gerar o contrato do cliente a partir de um **modelo com campos** (preenchidos pelo cadastro e
pela contratação), levar o **PDF** impresso ao Fechamento, mandar para **assinatura digital
(ZapSign)** e gerar o **link de pagamento (InfinitePay)**. Quando o contrato está **assinado e
pago**, a central faz sozinha o que hoje é manual: avança a trilha (regra do dia 15), manda o
formulário de acesso e cria o grupo "Em Movimento - <Empresa>" (D10).

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| K1 | **Modelos com campos** `{{cliente.razao_social}}`, `{{contrato.valor_mensal}}`… A central nasce com um modelo inicial de prestação de serviços de marketing, **para ser trocado** pelo texto que o dono usa hoje (o resumo dos modelos virá do outro chat). Campo que não tem valor aparece destacado como pendência antes de gerar. | O texto do contrato é do dono; o sistema só preenche. |
| K2 | O contrato guarda o **texto final** (cópia do modelo preenchido) — mudar o modelo depois não muda contrato já gerado. O PDF é sempre gerado desse texto. | Contrato não pode mudar depois de enviado. |
| K3 | **ZapSign e InfinitePay são opcionais** e configurados em Configurações: o token da ZapSign fica cifrado; a InfinitePay só precisa do InfiniteTag (handle). Sem eles, "assinado" e "pago" são marcados à mão, com a data. | O processo atual continua funcionando; a integração é um atalho. |
| K4 | **Webhooks com segredo no caminho e conferência ativa**: a ZapSign avisa `doc_signed` e a central confere o documento na API da ZapSign antes de aceitar; a InfinitePay avisa o pagamento e a central confere no `payment_check` antes de aceitar. Aviso falso não marca nada. | A InfinitePay não assina o webhook; a ZapSign só manda cabeçalho fixo. |
| K5 | **Assinado E pago** (a última das duas datas) dispara, uma vez: conclui o marco "Contrato assinado e pago" da trilha (regra do dia 15), põe o cliente como **ativo**, gera o link do formulário e manda no WhatsApp do responsável, cria o **grupo** com o cliente e a equipe dele pelo WhatsApp da agência (WAHA) e avisa quem recebe avisos gerais. Grupo que não pôde ser criado vira aviso "crie à mão". | D10 e Etapa 1 do mapa. |
| K6 | **Validade da proposta**: 5 dias depois do Fechamento (editável). Vencida sem assinar e pagar aparece como "proposta vencida"; **Recusou** põe o cliente em **remarketing**. | Mapa › Etapa 1. |
| K7 | O PDF também vai para a subpasta "02 Contrato e proposta" do Drive quando conectado. | D20. |
| K8 | Quem pode: `contratos.gerenciar` para tudo; configurar as integrações, `configuracoes.gerenciar`. | Vocabulário da Fase 1. |

## Fora desta fase

- Cobrança **recorrente** pela InfinitePay (a API pública cria link avulso; a mensalidade
  recorrente segue pelo painel da InfinitePay).
- Assinatura da própria agência no ZapSign (vai só o cliente; dá para incluir depois).

## Dados (migration 9008)

`agencia_contrato_modelos` (nome, corpo, ativo; nasce um), `agencia_contratos` (cliente,
contratação, modelo, texto final, valor mensal em centavos, forma de pagamento, dia de
vencimento, prazo em meses, data do fechamento, válido até, situação, assinado em, pago em,
concluído em, ZapSign — token, link, situação —, pagamento — link, `order_nsu` único, slug,
recibo —, arquivo no Drive, grupo criado). `agencia_config` ganha o token cifrado da
ZapSign, o ambiente, o InfiniteTag e o segredo dos webhooks (cifrado).

## Critérios de aceite

1. Modelo com campos gera o contrato com os dados do cliente; campo vazio é apontado.
2. PDF baixa a qualquer momento e é o texto guardado.
3. Marcar assinado e pago (à mão) dispara a trilha, o formulário, o grupo e o aviso — uma vez.
4. Webhook com segredo errado é recusado; aviso de pagamento que o `payment_check` não
   confirma não marca nada.
5. Recusou → cliente em remarketing.
