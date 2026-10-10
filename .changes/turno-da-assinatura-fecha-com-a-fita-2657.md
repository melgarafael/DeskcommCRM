---
impacto: nada_mudou
secao: corrigido
titulo: O agente pela assinatura fecha o turno — a fita da resposta chega ao fechamento
---

Na empresa de IA "OpenAI pela assinatura (ChatGPT)", o modelo respondia e a chamada era cobrada em Execuções, mas o turno quebrava logo depois: a tela do Testar mostrava só a frase genérica sobre modelo e credencial, e o log do app registrava `e is not iterable`. O ramo da assinatura usa o streaming do SIWC e monta o resultado da chamada à mão; faltava nele o campo `responseMessages`, que é a fita (resposta e ações de ferramenta) que o motor reenvia na chamada de fechamento do turno. Sem esse campo a fita chegava vazia e o fechamento morria antes de escrever o checkpoint. Agora a fita sai do streaming junto com o texto e o consumo, o compilador cobra cada campo que o motor lê no caminho da assinatura, e o turno fecha como em qualquer outro provedor — prévia do agente e WhatsApp. O mesmo objeto também não trazia as chamadas de ferramenta, e por isso as sugestões que pedem uma ferramenta só (assistente de propostas, "preencher com a conversa", importação de modelo de proposta e valor da conversa) não funcionavam pela assinatura (o assistente dizia que não tinha entendido a instrução); agora funcionam. Nada precisa ser feito ao atualizar.

Contribuição de @webtecnica (#2675), a partir da issue #2657 de @GabrielBottan.
