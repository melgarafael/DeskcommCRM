---
impacto: nada_mudou
secao: corrigido
titulo: Recuperação de checkout confere a tentativa no provedor
---

A contratação preparada consulta a sessão anterior na Stripe antes de abrir outra: reutiliza sessões abertas e aguarda a confirmação de sessões concluídas. O horário de expiração salvo localmente não autoriza uma segunda assinatura. Falhas ao recontratar uma assinatura encerrada mantêm a mesma tentativa e o vínculo anterior, sem liberar recursos como se a empresa fosse legada. A cobrança permanece desativada em produção.
