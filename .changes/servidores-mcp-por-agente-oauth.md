---
impacto: capacidade_nova
secao: adicionado
titulo: Cada agente pode ter os próprios servidores MCP (módulo opcional, desligado de fábrica), e o cliente autoriza o acesso à conta dele pela conversa
---

É um recurso opcional, **desligado de fábrica**: quem administra o servidor liga em **Admin › Sistema › Ferramentas externas por agente**. Desligado, nada muda para ninguém. Ligado, na tela do agente aparece a seção **Servidores MCP do agente**: até cinco servidores de ferramentas externos por agente, cada um com o seu jeito de entrar — sem autenticação, com uma chave fixa ou por OAuth. No modo OAuth, quem dá o acesso é o próprio cliente: quando ele pede algo que depende da conta dele em outro sistema (a casa automatizada, os pedidos, a conta), o agente envia um link na conversa, o cliente entra com o login dele e autoriza, e a partir da próxima mensagem o agente consulta só os dados daquele cliente. Outro cliente recebe o próprio link e nunca vê os dados do primeiro.

O acesso é renovado sozinho, é revogado quando a conversa encerra (ou depois de quantas horas você escolher) e some quando o contato é anonimizado. Na ficha do contato, na aba LGPD, a seção **Acessos a sistemas externos** mostra o que ele autorizou e tem o botão **Revogar**. Permitir que o agente faça ações na conta do cliente durante a conversa é uma opção separada, desligada de fábrica.

O servidor que você já cadastrou em Configurações › Servidor MCP externo continua funcionando como antes. Você não precisa mudar nada. Crédito: @felipedelvan.
