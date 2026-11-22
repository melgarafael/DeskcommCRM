---
impacto: nada_mudou
secao: corrigido
titulo: A cobrança do Asaas adota o cliente que já existe pelo CPF/CNPJ em vez de criar um segundo, mesmo quando ele já tem cobrança ou assinatura na conta
---

Ligar a cobrança de uma empresa cujo CPF/CNPJ já existe como cliente na conta
do Asaas — cadastrado direto no painel, fora do CRM — criava um segundo cliente
com o mesmo documento. A assinatura ficava no novo e o antigo continuava lá. A
busca do CRM só conhecia o vínculo que ele mesmo grava no cliente
(`externalReference` = id da empresa); cliente do painel não tem esse vínculo.

Agora, quando a busca pelo vínculo não acha nada, a cobrança procura pelo
documento e adota o cliente que já existe, gravando o vínculo nele para as
próximas vezes. Nome, e-mail, telefone e notificações que o operador cadastrou no
Asaas ficam como estão: a adoção grava só o vínculo.

A versão anterior desta correção deixava de fora o cliente que já tinha cobrança
ou assinatura na conta, e era justamente o caso mais comum de quem cadastrou o
pagador no painel. Adotar esse cliente agora é seguro porque a releitura passou a
considerar só o que é da própria empresa — na CRIAÇÃO e, desde aqui, também na
LEITURA: `lerSituacao` recebeu a organização e o Asaas só considera assinaturas
com o vínculo dela e as cobranças dessas assinaturas. Antes, a situação da empresa
podia ser calculada com o que é de outra integração (assinatura viva a mais,
pagamento antigo contando como nosso) e a referência devolvida — gravada em
`provedor_assinatura_id` — apontava para a assinatura de fora, de modo que
cancelar ou trocar de plano agia sobre ela. A assinatura antiga continua
intacta e nada é apagado no Asaas.

Quando há mais de um cliente com o mesmo documento, a regra é explícita: o mais
antigo (o pagador original, não a duplicata) e, no empate, o de menor
identificador — sempre com aviso no log e sem criar um terceiro. Cliente que já
tem o vínculo de outra empresa continua não sendo adotado.

Limpeza dos duplicados que já existem em produção fica fora desta mudança: nada
é apagado e nenhuma assinatura existente é migrada.

Contribuição de @webtecnica (#4768).
