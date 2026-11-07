---
impacto: capacidade_nova
secao: adicionado
titulo: Catálogo de serviços como módulo opcional: serviço com tipo, variações, prazo e sinal
---

Novo módulo opcional, instalado em Módulos pelo administrador da instalação. Sem instalar, nada muda: a tabela do módulo não existe, as rotas de serviço respondem 404 e a busca de produtos do agente segue igual.

Depois de instalar, um item do catálogo pode ser serviço: hora marcada, projeto ou plano recorrente, com variações (cada uma com nome, código e preço próprios), prazo em dias úteis no projeto, sinal percentual ou fixo e instruções internas para o agente. O preço continua sendo o do item do catálogo. O agente passa a responder com "a partir de", as variações, o sinal calculado e o prazo, e deixa de oferecer o serviço marcado para não oferecer. O sinal fixo nunca passa do menor preço da família, inclusive quando o preço muda pela tela de produtos ou pela planilha. Base de @webtecnica (#3480).
