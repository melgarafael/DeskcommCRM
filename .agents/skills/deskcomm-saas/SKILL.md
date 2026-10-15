---
name: deskcomm-saas
description: 'Guia para revender o DeskcommCRM como SaaS próprio: painel do dono, empresas-clientes, planos e teste grátis, cobrança pela Stripe ou pelo Asaas, régua de atraso, troca de plano, nota fiscal e contrato/LGPD. Use quando alguém quiser "vender o CRM", "cobrar meus clientes", "criar planos", "ligar a Stripe/Asaas".'
metadata:
  publico: revendedor, agência, dono de instalação
  fonte-de-verdade: docs/saas/
---

# Revender o DeskcommCRM como SaaS

Você está ajudando o **dono de uma instalação** a vender o DeskcommCRM para os clientes dele.
Quase sempre ele não programa. O que ele quer é ter clientes pagando, e não entender o código.

A fonte da verdade são os guias em `docs/saas/` deste repositório:

| Assunto | Guia |
|---|---|
| A jornada inteira, o modelo, o painel do dono, o primeiro cliente, o custo por cliente | `docs/saas/README.md` |
| Instalar numa VPS com Coolify, com o banco na própria VPS; atualizar; backup | `docs/saas/coolify.md` |
| Planos, Stripe ou Asaas, régua, troca de plano, nota fiscal, caminho manual | `docs/saas/cobranca.md` |
| Contrato e LGPD com o cliente final | `docs/saas/contrato-e-lgpd.md` |
| Roteiros para quem ensina | `docs/saas/aulas/` |

**Leia o guia do assunto antes de responder.** Quando este arquivo e o guia discordarem, vale o
guia; quando o guia e o código discordarem, vale o código: leia o trecho e diga a divergência.

## Como você fala e age

1. Em português simples. "A empresa-cliente", "o painel do dono", "a chave de teste": nunca
   "tenant", "webhook" ou "env" sem traduzir na mesma frase.
2. Uma coisa de cada vez. Uma pergunta, espere, siga.
3. **Nunca peça nem repita no chat** chave de API, senha ou token. Chave de pagamento se cola
   **na tela** do sistema (Cobrança › Conexão), não na conversa. Se a pessoa colar uma chave no
   chat, não a use: peça que ela gere outra no provedor e apague a que vazou.
4. **Chave de produção só depois da compra de teste dar certo.** `sk_live_`, `rk_live_` e
   `$aact_prod_` nunca entram antes disso, nem "só para testar".
5. Instalar, atualizar ou consertar a instalação é do guia `deskcomm-instalar`; montar os
   agentes de um cliente por nicho é do `deskcomm-cliente-novo`. Passe a bola quando o pedido
   for desses.

## Primeiro: onde a pessoa está

Pergunte, uma por vez, e pule o que já estiver claro:

| Pergunta | Se a resposta for… | Vá para |
|---|---|---|
| Já tem o CRM instalado? | Não | `docs/saas/coolify.md` (ou o guia `deskcomm-instalar`) |
| Em que versão? | Não sabe | Peça para rodar `curl -s https://SEU_DOMINIO/api/v1/health` e ler `"version"`. Cobrança com Stripe exige 1.78.0 ou mais; com Asaas, 1.79.0 ou mais. Abaixo disso, atualize primeiro |
| Já tem cliente criado no painel? | Não | `docs/saas/README.md`, etapas 3 e 4 |
| Vai cobrar dentro do sistema? | Sim | `docs/saas/cobranca.md` |
| Os clientes pagam como? | Pix ou boleto | Asaas |
| | Cartão no automático | Stripe |
| | Outro jeito | O caminho manual, no fim de `cobranca.md` |

## O caminho da cobrança, na ordem

1. **Ligar:** painel › Recursos opcionais › Cobrança dos seus clientes. As empresas que já
   existem ficam isentas.
2. **Conectar** em Cobrança › Conexão, com a **chave de teste**: Stripe (`sk_test_` ou
   `rk_test_`) ou Asaas sandbox (`$aact_hmlg_`). O selo MODO DE TESTE tem de aparecer.
3. **Planos:** criar, **Salvar plano** e marcar **Usar no cadastro** no plano de quem se cadastra
   sozinho. O preço mínimo é R$ 5,00. O preço e o intervalo travam quando alguém assina.
4. **Régua:** dias de tolerância (5 a 30, padrão 7).
5. **Compra de teste** numa empresa de teste, pela tela do cliente (Configurações › Plano e
   cobrança). Os detalhes de cada provedor estão no guia.
6. **Publicar:** trocar pela chave de produção em Conexão.
7. **Pôr cada cliente num plano:** ao criar a empresa (Plano de cobrança) ou em Tenants › empresa
   › card Cobrança.
8. **Cliente que não vai entrar no sistema:** Tenants › empresa › card Cobrança › **Gerar link de
   pagamento** (no Asaas, com o CPF/CNPJ de quem paga) e **Copiar link de pagamento** para o WhatsApp.

## Erros que a pessoa vai cometer, e o que dizer

| O que ela diz ou vê | O que é | O que fazer |
|---|---|---|
| "Quem se cadastra não tem teste grátis" (e usa de graça, sem limite) | Faltou **Usar no cadastro** | Aba Planos, no plano certo |
| "Testar e conectar não liga" | Falta colar a chave, ou o endereço da instalação não é https público | Se a tela avisa que o provedor "só avisa pagamentos num endereço https público", confira `NEXT_PUBLIC_APP_URL` no `.env` da instalação: tem de ser o `https://` do domínio. Abrir o painel por outro endereço não resolve |
| "Falta um passo: cadastre o aviso de pagamento no Asaas" | O Asaas recusou o cadastro automático do aviso | Seguir o quadro da tela; o token aparece uma vez só |
| "O cliente não consegue assinar pelo Asaas" | Falta CPF ou CNPJ válido | Campo "CPF ou CNPJ de quem paga" |
| "O cliente recebeu dois avisos de cobrança" | Pode ser o aviso padrão do Asaas, além do do sistema | O sistema pede ao Asaas que não avise, mas a entrega não foi medida. Se incomodar, desligue os avisos desse cliente no painel do Asaas |
| "Quero mudar o preço do plano" | O preço trava depois da primeira assinatura | Arquivar e criar outro |
| "O cliente trocou de plano e não mudou nada" | Depois do teste, a troca vira na próxima cobrança paga | Explicar; é proposital |
| "Não deixa trocar de mensal para anual" | Troca só entre planos do mesmo intervalo | Cancelar e assinar o plano novo |
| "Conectou, mas o cliente não consegue assinar" (Stripe, chave `rk_`) | A chave restrita sem escrita em **produtos** | Gerar a chave restrita com produtos, ou usar a `sk_` |
| "A empresa foi suspensa, quero liberar já" | A régua só reativa quando o pagamento chega | Tenants › empresa › Cobrança: Dar prazo ou Tornar isenta |
| "Faixa: suas empresas reais ainda não conseguem pagar" | A conexão está com a chave de teste | Fazer a compra de teste e publicar |
| "Preciso emitir nota fiscal" | O sistema não emite | É do revendedor; o Asaas oferece emissão na conta dele, a combinar com o contador |

## Contrato e LGPD

Antes do primeiro cliente pagante, leve a pessoa a `docs/saas/contrato-e-lgpd.md`. Três pontos
que ela erra:

- A empresa-cliente é a **controladora**; o revendedor é o **operador**. O relatório de LGPD
  sai com a razão social do cliente, nunca com a marca do revendedor.
- Com a IA ligada, **há transferência internacional** de dados, e ela vai no contrato. "Servidor
  no Brasil" não resolve a IA.
- Aquilo é um roteiro para um advogado revisar, não um contrato pronto.

## Para conferir em vez de afirmar

- Versão no ar: `curl -s https://SEU_DOMINIO/api/v1/health` (campo `"version"`).
- CRM no ar: `curl -sSI https://SEU_DOMINIO/app | head -1` dá `HTTP/2 307`. A raiz dá `200`,
  porque é uma página pública.
- Regras da troca de plano: `lib/cobranca/troca.ts`, comentário do topo.
- Provedores aceitos pela cobrança: `lib/cobranca/provedores/`.
