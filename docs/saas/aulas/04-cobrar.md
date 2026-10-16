# Aula 4 · Cobrar: planos, Stripe ou Asaas, régua

**Entrega:** a cobrança ligada, um provedor conectado em modo de teste, um plano criado e uma
compra de teste concluída.
**Guia de referência:** [`../cobranca.md`](../cobranca.md).

## Preparar antes de gravar

- A Aula 3 concluída, com o envio de e-mail configurado.
- Conta na Stripe **ou** conta de sandbox no Asaas. Grave os dois caminhos em partes separadas
  se o seu público usa os dois.
- Uma empresa de teste, com outro e-mail seu.

## Cenas

1. **Stripe ou Asaas:** a tabela do guia. Pix e boleto → Asaas; cartão no automático → Stripe.
2. **Ligar** em Recursos opcionais › Cobrança dos seus clientes. As empresas antigas ficam
   isentas.
3. **Conectar** com a chave de **teste** (borrada na tela) e ler o selo MODO DE TESTE.
4. **Criar o plano** e marcar **Usar no cadastro**.
5. **A régua:** a tolerância e a linha do tempo da tela.
6. **A compra de teste** como o cliente: Stripe com o cartão `4242 4242 4242 4242`; Asaas com
   CPF ou CNPJ, **Abrir a fatura** e **Já paguei**.
7. **Publicar**: trocar pela chave de produção (não grave a chave), o aviso de quem assinou em
   teste e o **Publicar mesmo assim**.
8. **Dar prazo e isentar** no card Cobrança da empresa.

## O erro que vale mostrar

Esquecer o **Usar no cadastro**: quem se cadastra sozinho não ganha teste grátis nem tem o que
assinar.

## Tarefa do aluno

A compra de teste concluída **antes de publicar**: com a Stripe e teste grátis, a empresa fica em
"Teste grátis" com a primeira cobrança agendada ("Tudo certo: a primeira cobrança sai no fim do
teste grátis."); com o Asaas, "Em dia" depois do pagamento de teste. Publicar devolve as
assinaturas de teste ao teste grátis, então o print vem antes da cena 7.
