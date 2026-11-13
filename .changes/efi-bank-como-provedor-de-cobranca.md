---
impacto: capacidade_nova
secao: adicionado
titulo: Efi Bank entra como provedor de cobrança, com boleto recorrente e link do próprio Efi
---

O DeskcommCRM já cobrava pela Stripe e pelo Asaas. Agora cobra também pelo **Efi Bank**: a tela
de **Conexão** ganhou o provedor, e a credencial da aplicação (Client-Id e Client-Secret) é
cadastrada e guardada cifrada como as dos outros dois.

O Efi entra no **mesmo contrato** dos outros provedores, então tudo que já existia continua
funcionando: assinatura criada pelo checkout, leitura do pagamento pela régua, aviso de pagamento
com idempotência, suspensão por atraso e liberação ao pagar. **Nada muda** para quem usa Stripe ou
Asaas, e a troca de provedor continua sendo recusada depois do primeiro pagamento real.

Três diferenças do Efi estão à mostra na tela e na documentação, em vez de escondidas:
**ele não tem cadastro de cliente** (o pagador é informado na página dele),
**não tem portal** (gerenciar é abrir a fatura aberta) e
**não aplica troca de plano** na assinatura — o preço novo passa a valer no próximo ciclo e a
auditoria registra a recusa. O aviso de pagamento **não é cadastrado no painel do Efi**: a URL e o
token viajam em cada cobrança criada pela instalação.
