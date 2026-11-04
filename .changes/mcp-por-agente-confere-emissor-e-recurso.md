---
impacto: nada_mudou
secao: corrigido
titulo: Servidores MCP por agente conferem os dados de autorização e respeitam o tempo do atendimento
---

Vale só para quem ligou o módulo opcional de servidores MCP por agente.

Ao cadastrar ou testar a conexão de um servidor com OAuth, a descoberta agora confere que os dados de autorização devolvidos são do servidor informado e do emissor que ele indicou. Quando não são, o cadastro é recusado com uma mensagem na própria tela de "Testar conexão".

No atendimento, esses servidores passam a ter o mesmo limite de tempo que o servidor MCP da organização já tinha: 8 segundos para listar as ferramentas e 8 segundos por chamada. Se o servidor não responder, o agente segue a conversa sem aquela ferramenta.

Você não precisa mudar nada.
