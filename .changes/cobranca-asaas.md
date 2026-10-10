---
impacto: capacidade_nova
secao: adicionado
titulo: Você pode cobrar as empresas que atende pelo Asaas, com Pix e boleto todo mês
---

A cobrança dos seus clientes ganha um segundo provedor de pagamento: o Asaas. Com ele, a empresa que você atende recebe a cobrança todo mês (ou todo ano) e paga por Pix, boleto ou cartão, sem precisar cadastrar cartão — a Stripe no Brasil não oferece Pix. O pagamento por Pix ou boleto é feito a cada cobrança, não é débito automático. É opcional: quem não usa a cobrança não vê diferença nenhuma.

Para usar, vá em Admin › Cobrança › Conexão, escolha Asaas e cole a chave de API da sua conta do Asaas. A tela explica em uma frase para que serve cada provedor e mostra se a chave é de teste (sandbox) ou de produção; da chave, só os quatro últimos caracteres ficam à vista. O aviso de pagamento é cadastrado sozinho na sua conta do Asaas. Se a sua conta não permitir, a tela mostra o passo a passo para cadastrá-lo no painel do Asaas, com um código de segurança que aparece uma vez só.

Na hora de assinar, a empresa informa o CPF ou o CNPJ de quem paga, já preenchido com o CNPJ do cadastro dela. O número é conferido antes de ir ao Asaas e não fica guardado no sistema. Avisos de atraso, tolerância, suspensão e reativação automática funcionam como na Stripe.

As assinaturas novas usam um provedor só, o que você escolher; as que já existem continuam no provedor em que nasceram, e a tela não deixa trocar de provedor enquanto houver empresas pagando no outro. Nenhuma configuração ou ação é necessária para atualizar.
