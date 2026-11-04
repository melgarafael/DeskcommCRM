---
impacto: nada_mudou
secao: corrigido
titulo: O atendimento deixa de esperar até 30 segundos por um servidor MCP externo que não responde
---

Quando a organização tem um servidor MCP externo (o sistema da loja, da clínica, do prontuário) e ele para de responder — firewall, deploy travado, DNS errado —, o turno do atendimento esperava o tempo padrão do cliente MCP em cada passo da conversa com o servidor: até 15 segundos para abrir a conexão e mais 15 para listar ou chamar a ferramenta. Com o cliente esperando no WhatsApp, isso é tempo que o agente passa calado antes de começar a responder; com mais de uma ferramenta remota no mesmo turno, o pior caso passava de um minuto.

Agora o turno tem orçamento próprio, curto: 8 segundos para descobrir as ferramentas e 8 segundos por chamada. Estourou, o turno segue com as ferramentas do CRM e responde ao cliente — o mesmo comportamento de quando o servidor está fora do ar, sem erro técnico na conversa. A tela de cadastro (Configurações › Servidor MCP externo) e o cartão do agente continuam com o tempo maior de antes: ali quem espera é quem está administrando, e um servidor lento merece o benefício da dúvida.

Você não precisa mudar nada.
