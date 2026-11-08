---
impacto: nada_mudou
secao: corrigido
titulo: A lista de agentes mostra a cópia e o nome novo na hora, sem recarregar a página
---

Em **IA › Agentes**, usar **Duplicar** ou **Renomear** no menu de um agente
mostrava a mensagem de sucesso, mas a lista continuava igual: a cópia só
aparecia, e o nome novo só valia na tela, depois de recarregar o navegador.
Agora a lista se atualiza assim que a ação termina. O mesmo vale para Pausar,
Despausar e Arquivar.

O cartão de um agente duplicado também passa a mostrar o modelo de IA da cópia.
Antes ele podia mostrar o modelo padrão (por exemplo, Anthropic · Claude Sonnet)
para a cópia de um agente que usa a OpenAI, enquanto o editor mostrava o modelo
certo. O que o agente responde não mudou: o problema era só no cartão. Cópias
feitas antes desta versão voltam a mostrar o modelo certo quando forem
publicadas.

Crédito: @andradevander.
