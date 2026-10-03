---
impacto: nada_mudou
secao: corrigido
titulo: O gasto de quem atende com Gemini passa a ser contado, e o teto mensal passa a valer
---
Os seis modelos Gemini oferecidos na escolha de modelo do agente (Gemini 3.5 Flash, 3.1 Pro, 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite e 2.0 Flash) não tinham preço na conta que o atendimento faz a cada resposta. Cada chamada era registrada com custo desconhecido, e o orçamento conta custo desconhecido como zero: em Uso e orçamento o gasto de uma organização em Google aparecia zerado, e o teto mensal de gasto com IA nunca disparava, por maior que fosse o uso.

Agora cada resposta do agente em Gemini é registrada com o preço do catálogo, o mesmo que a tela já mostrava na escolha do modelo. O trecho repetido da conversa, que o Google cobra com desconto, é contado pela tarifa de cache publicada pelo Google (um décimo do preço de entrada). O gasto aparece em Uso e orçamento e o teto mensal passa a valer para quem usa Google.

O que isso muda na prática: numa organização em Gemini com o teto ligado no modo que bloqueia, se o gasto real do mês já estiver acima do teto escolhido, as respostas da IA passam a ser barradas e as conversas vão para a fila humana. É o teto fazendo o que foi configurado para fazer, e que antes não fazia porque o gasto chegava zerado. Com o teto desligado (o padrão) ou só avisando, nada é barrado. O gasto de cada organização e o teto ficam em IA › Uso e orçamento.

Uma limitação declarada: as conversas acima de 200 mil tokens de entrada no 2.5 Pro e no 3.1 Pro, que o Google cobra mais caro, são contadas pelo preço normal.

O gasto passado não é recalculado: chamadas antigas continuam sem custo. A atualização não pede nenhuma mudança na instalação.
