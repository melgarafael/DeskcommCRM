---
impacto: capacidade_nova
secao: adicionado
titulo: Quem revende o CRM pode criar plano de cobrança em dólar ou euro, além de real
---
Na aba Planos da cobrança, o plano novo ganha o campo Moeda, com real, dólar e euro. Com a Stripe conectada, o pagamento sai na moeda do plano, e a página de pagamento abre no idioma do navegador de quem paga quando o plano não é em real. O link do cadastro pode pedir a moeda (`/signup?moeda=USD`), ou vir com um plano escolhido (`?plano=`), e aí o seletor mostra só os planos daquela moeda. A moeda fica fixa depois que o plano é criado, e a troca de plano só oferece planos na mesma moeda. Com o Asaas, que só cobra em real, o plano em outra moeda é recusado ao ser criado. Os preços dos planos passam a ser escritos na convenção da moeda deles, em todas as telas. Crédito: @kahuemorais.
