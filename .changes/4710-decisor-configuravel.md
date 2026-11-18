---
impacto: capacidade_nova
secao: adicionado
titulo: O modelo que o Jev usa para decidir passa a ser escolhido na tela dele, com aceite novo a cada troca
---

O Jev decide coisas como passar a conversa para uma pessoa, reconhecer quem pediu para sair da lista e medir o clima da conversa, e até aqui o modelo dessas decisões era fixo: o typesafe/jev-1.13. A tela dele, em Provedores de IA, ganhou o campo "Modelo do decisor": quem usa o Jev pela OpenRouter pode apontar outro modelo que declare a saída de decisões lá, e a escolha vale para todas as tarefas do Jev de uma vez. Dá para voltar ao Jev com um clique, e se o modelo escolhido falhar numa conversa o Jev responde no lugar dele. Contribuição de @webtecnica (issue #4710).

Trocar o modelo troca quem recebe a mensagem do cliente, então cada troca pede o "concordo" de novo, e o texto nomeia o fornecedor do modelo escolhido e diz que, se esse modelo falhar, a mensagem vai para o Jev, da TypeSafe AI, pela OpenRouter; voltar ao Jev não pede. O aviso para a área da saúde e o texto de antes de ligar também passam a citar esse fornecedor. O que é enviado não muda: uma mensagem por vez, sem o resto da conversa. Ninguém conferiu os termos de privacidade, de retenção e de treino dos fornecedores do catálogo, e o aceite diz que a empresa assume essa conferência, em especial nos modelos gratuitos.

O Jev continua sendo o padrão de quem não mexer em nada. A troca usa a mesma credencial OpenRouter da conversa, sem segunda conta e sem segunda chave; quando a lista de modelos não pôde ser conferida no momento, nada é gravado e a tela diz por quê. Outro modelo muda as probabilidades das decisões, então a orientação na própria tela é deixar a tarefa em Observando e comparar antes de deixá-lo decidir.
