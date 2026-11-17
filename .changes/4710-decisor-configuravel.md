---
impacto: capacidade_nova
secao: adicionado
titulo: O modelo que decide a passagem para humano passa a ser escolhido na tela do Jev
---

O Jev decide quando passar a conversa para uma pessoa, e até aqui esse modelo era fixo: o typesafe/jev-1.13, que é o único calibrado para o corte de passagem. A tela dele, em Provedores de IA, ganhou o campo "Modelo do decisor": dá para apontar outro modelo que declare a saída de decisões na OpenRouter, voltar ao Jev com um clique e ver, junto do campo, com qual modelo ele está respondendo agora.

O Jev continua sendo o padrão de quem não mexer em nada, e as tarefas que estavam em Observando seguem em Observando. A troca usa a mesma credencial OpenRouter da conversa, sem segunda conta e sem segunda chave; quando a credencial não está lá, ou quando a lista de modelos não pôde ser conferida no momento, nada é gravado e a tela diz por quê. Como outro modelo muda as probabilidades do corte, a orientação na própria tela é comparar o comportamento antes de deixá-lo decidir.
