---
impacto: capacidade_nova
secao: adicionado
titulo: A empresa escolhe quais tipos de link do contato a ficha e o funil mostram
---

A ficha do contato e o card do funil mostram nove tipos de link — Instagram, link na bio, site, Google Meu Negócio, Facebook, LinkedIn, TikTok, YouTube e "Outro". O catálogo era fixo no código, e toda operação carregava campo que não usa: clínica não preenche TikTok, escritório não preenche Google Meu Negócio.

Agora **Configurações → Tipos de link do contato** (admin) marca e desmarca quais tipos aparecem. O formulário do contato no funil e a exibição na ficha e no card passam a mostrar só os tipos marcados.

O que **não** muda: desmarcar um tipo não apaga nada. O valor já preenchido continua gravado no contato e volta a aparecer se o tipo for marcado de novo — salvar o formulário com um tipo escondido não apaga o que está fora da tela. Quem nunca abriu a tela continua vendo os nove tipos, exatamente como antes: a escolha só existe depois de alguém salvar.

A escolha é por empresa e fica em `organizations.settings`, sem migration. As ferramentas de administração (Diagnóstico da ficha e Comparação de fichas) continuam mostrando o catálogo inteiro, porque existem justamente para enxergar o que ficou escondido; API, MCP, webhook e prospecção também seguem lendo e gravando todos os tipos.

Contribuição de @webtecnica (#5128).
