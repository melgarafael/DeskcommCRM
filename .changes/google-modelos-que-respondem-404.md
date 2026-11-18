---
impacto: nada_mudou
secao: corrigido
titulo: Instalação com provedor Google deixa de escolher, para o tier econômico, Gemini que o provedor aposentou
---

Quatro modelos que o catálogo do Google oferecia — `gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` e `gemini-2.5-pro` — respondem 404 hoje: o 2.0 saiu de linha e os três 2.5 estão fechados para contas novas. Numa instalação com provedor Google, o tier econômico dos pontos (`checkpoint`, `promise_semantic` e os demais) escolhia o 2.0 Flash justamente por ser o mais barato e tomava 404 em todo turno, com o fail-open do motor escondendo a causa — o que aparecia era custo e latência, não erro.

A escolha automática passou a exigir duas coisas do candidato: que o motor saiba cobrá-lo e que o provedor ainda o sirva. O modelo aposentado continua com preço na tabela — instalação antiga e roteador ainda o chamam, e custo nulo calado é o defeito oposto —, mas sai da corrida do econômico. O escolhido passa a ser `gemini-3.1-flash-lite`, a US$ 0,25 de entrada e US$ 1,50 de saída por milhão de tokens, o mais barato que o Google hoje serve; uma organização que já esteja num dos ids aposentados é migrada para ele na próxima chamada, em vez de cair em outro modelo morto. Preço, modelos e escolha dos outros provedores não mudaram, e a instalação que não usa Google não sente diferença.
