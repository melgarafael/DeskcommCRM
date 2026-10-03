---
impacto: nada_mudou
secao: corrigido
titulo: O roteador volta a escolher qual agente atende cada mensagem
---

Em empresas que usam a OpenRouter, o roteador de agentes falhava a cada mensagem com o erro "claude-haiku-4-5 is not a valid model ID" e nenhuma escolha de agente acontecia — toda conversa caía no mesmo agente, ou em nenhum, como se os roteadores configurados não existissem. A mensagem nunca aparecia no painel de erro: era o aviso que a própria tela do classificador mostrava.

O modelo do classificador vinha gravado pelo próprio Deskcomm ao criar o roteador, com um nome que a OpenRouter não reconhece. Ninguém escolheu esse modelo, e a empresa podia ter configurado Claude como modelo de atendimento — o roteador é que insistia no dele. Agora o roteador nasce em "Automático": quem decide o modelo do classificador é o painel de provedores ou, na falta dele, o modelo de atendimento da empresa, e nenhuma escolha é sobrescrita por baixo dos panos.

Quem já tinha um roteador com esse modelo gravado de fábrica, numa empresa que não usa a Anthropic diretamente, passa para "Automático" ao atualizar. Se quiser um classificador mais barato e rápido do que o modelo de atendimento, basta escolhê-lo na tela do roteador. Empresas que usam a Anthropic diretamente não mudam nada: lá esse modelo funciona, e o roteador continua com ele. Também não muda nada para quem escolheu o modelo do classificador na tela, inclusive o Claude Haiku 4.5 pela Requesty, nem para quem não usa roteador de agentes. Não é preciso fazer nada na instalação.

Contribuição de @dilneiss (#2134).
