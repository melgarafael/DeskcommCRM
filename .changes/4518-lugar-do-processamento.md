---
impacto: capacidade_nova
secao: adicionado
titulo: Catálogo de IA diz por que um provedor não declara onde processa, e o que o endpoint próprio muda
---

A cláusula de transferência internacional e a tela já mostravam, para cada provedor de IA, o país quando ele é conhecido. Faltavam duas respostas, e as duas eram escritas à mão em quem monta o contrato: **por que** um provedor não declara a região de processamento, e **o que acontece com o lugar** quando o operador aponta a base URL para outro endereço.

O catálogo de provedores passa a guardar as duas. O motivo é por provedor — a OpenAI declara residência de dados por projeto e região, a Gemini Developer API não publica a lista de países, o OpenRouter escolhe o provedor por modelo a cada chamada, a Requesty e a ElevenLabs não têm fonte citável — em vez de uma frase igual para todos. E o provedor que aceita endpoint próprio diz, na própria entrada, que a execução passa a ser no host configurado e que o país registrado deixa de valer; o provedor personalizado declara que o texto fica no servidor do operador, e o CRM não sabe onde ele está.

Nada muda no que a cláusula gerada imprime hoje: nenhum país novo é afirmado sem fonte. A tela e o documento que passam a mostrar os dois campos são as issues seguintes.

Funciona para o catálogo inteiro — conversa, decisão e voz —, e o teste de completude reprova provedor que entre sem motivo ou sem a resposta do endpoint próprio.

A partir da issue #4518.
