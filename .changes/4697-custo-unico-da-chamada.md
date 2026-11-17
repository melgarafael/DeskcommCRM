---
impacto: nada_mudou
secao: corrigido
titulo: O custo da chamada de IA passa a ter uma regra só, e a assinatura se declara equivalente
---

Numa instalação real, entre 22 de outubro e 2 de novembro, 271 de 457 turnos gravaram `cost_cents` nulo em `llm_calls` enquanto outros, do mesmo provedor, modelo e propósito, saíam com número — e não havia no código um lugar que dissesse qual regra valia. Agora a decisão mora num módulo só (`custo-da-chamada.ts`), e o seam apenas resolve as quatro entradas e pergunta: preço informado pelo provedor, tarifa por passo do Terra, tabela do motor ou catálogo da instalação. Quando o provedor é a assinatura, o número sai marcado como **equivalente de API** — é o preço que a chamada custaria na API, não dinheiro que saiu da conta —, e essa é a regra única: sempre o equivalente, nunca zero, porque o painel de custo e o teto de gasto só somam a coluna e zero seria lido como "grátis". Modelo que nenhum dos dois catálogos conhece continua com custo nulo, e agora o motivo (`sem_preco`) vai no log da linha em vez de ficar calado; chamada que falha antes do uso segue sem custo nenhum, com a linha de erro explicando o porquê. A transcrição paga parou de gravar `provider = 'desconhecido'` quando o serviço tem endereço próprio: a linha passa a usar o provedor que a escada de transcrição já anuncia — no caso real, `whisper-large-v3-turbo` aparece como `openai`, o protocolo do serviço.

Contribuição de @webtecnica (#4697).
