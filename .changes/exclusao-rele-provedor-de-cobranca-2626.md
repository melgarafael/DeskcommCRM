---
impacto: nada_mudou
secao: corrigido
titulo: Excluir um tenant confere a assinatura com o provedor de cobrança na hora, e recusa se o provedor não responder
---

A exclusão de tenant pelo painel de administração passa a consultar o provedor de cobrança no momento da exclusão, em vez de confiar na última leitura gravada. Uma assinatura que voltou a ficar ativa depois dessa leitura agora impede a exclusão, e uma que já foi cancelada no provedor deixa de impedir. Se o provedor não responder, a exclusão é recusada e nada é apagado: basta tentar de novo, ou conferir a conexão em Cobrança. Nada precisa ser feito ao atualizar. Contribuição de @webtecnica (#2650), a partir da issue #2626.
