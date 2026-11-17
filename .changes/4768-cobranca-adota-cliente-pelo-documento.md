---
impacto: nada_mudou
secao: corrigido
titulo: A cobrança no Asaas adota o cliente que já existe na conta pelo CPF/CNPJ em vez de criar um duplicado
---

Quem já tinha cadastro no painel do Asaas — fora do CRM — ganhava um **segundo** cliente com o mesmo CPF/CNPJ na hora de assinar: a cobrança só procurava o cliente pelo identificador da organização, e o cadastro feito no painel não tem esse identificador. A assinatura ia para o cliente novo, e o antigo continuava lá, com o histórico de cobranças dele.

Agora, antes de criar, a cobrança procura o cliente pelo identificador da organização e, não achando, pelo **documento**. Achado por documento, o cliente é adotado — o identificador da organização é gravado nele, quando a chave tem permissão para editar clientes — e nenhum cliente novo é criado. Se a conta já tem mais de um cliente com o mesmo documento, a escolha é sempre a mesma e está escrita: o **mais antigo**, e o menor identificador quando as datas empatam; a cobrança avisa no log (`cobranca.asaas.cliente_duplicado`) e não cria um terceiro. Cliente que já tem vínculo com outra empresa, ou que já tem cobrança ou assinatura na conta, não é adotado: a cobrança cria um novo, como antes.

Nada de cliente é apagado no Asaas, nenhuma assinatura existente é tocada e o contrato do webhook não mudou. Limpeza dos duplicados que já existem e migração das assinaturas antigas ficam fora desta correção.
