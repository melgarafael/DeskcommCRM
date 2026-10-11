---
impacto: capacidade_nova
secao: corrigido
titulo: Trocar de plano no teste grátis não espera mais o link de pagamento vencer
---

Quando a empresa trocava de plano no teste grátis com um link de pagamento ainda em aberto, a troca era recusada até o link vencer (até 24 horas) ou ser pago. Agora o sistema cancela esse link no provedor de pagamento e a troca vale na hora; o próximo "Assinar" gera um link novo, já com o preço do plano escolhido. Se o provedor não confirmar o cancelamento, nada muda e a recusa de antes continua valendo, para nenhum link sobreviver com o preço antigo. Links criados antes desta versão seguem a regra antiga até vencerem.

A releitura da cobrança também passou a conferir o preço da assinatura no provedor contra o preço do plano gravado. Quando os dois divergem, o registro de auditoria ganha a ação `cobranca.preco_divergente`, com os dois valores. Nada é corrigido sozinho: quem administra decide.

Você não precisa fazer nada. A atualização acrescenta uma coluna opcional em `cobranca_assinaturas`, aplicada pelo próprio `update.sh`.

Contribuição de @webtecnica (#2697), a partir da issue #2609.
