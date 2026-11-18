---
impacto: capacidade_nova
secao: adicionado
titulo: O catálogo de IA passa a dizer por que um provedor não declara a região, e o que o endpoint próprio faz com ela
---

O catálogo de provedores já respondia para onde vai o texto do cliente, mas só quando a resposta era um país. Quando era "o provedor não declara", a resposta vinha sem motivo: `fonteDoPais` nulo dizia que não havia fonte, e não dizia se era porque o provedor não publica a região, porque publica por projeto e região — o caso da OpenAI e do Gemini — ou porque ninguém conferiu. Agora cada provedor do catálogo de conversa, o Jev e o serviço de voz carregam `motivoDaRegiaoNaoDeclarada`, com a frase que explica a ausência; quem declara a região, como a DeepSeek, tem o campo nulo, e a cerca cobra os dois lados.

Junto veio a segunda pergunta que faltava: `aceitaEndpointProprio` dizia que a base URL pode ser trocada, e nada dizia o que a troca faz com o lugar. Quem aponta um ponto para um gateway, um LiteLLM ou um proxy corporativo sabe onde o host fica; o CRM não. O campo `ondeExecutaComEndpointProprio` declara isso para quem aceita endpoint próprio — e é nulo para quem não aceita, para que o país do provedor não seja herdado por uma chamada que saiu para outro endereço.

Nada muda para quem já usa o sistema: são campos declarativos do catálogo, sem tabela nova, sem migration e sem chamada de rede, preenchidos só com o que cada provedor publica — provedor sem fonte citável continua sem país, agora com a razão escrita.

Contribuição de @webtecnica (#4518).
