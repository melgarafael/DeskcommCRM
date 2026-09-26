---
impacto: capacidade_nova
secao: adicionado
titulo: O Jev passa a perceber pedidos para falar com uma pessoa ou para parar de receber mensagens que a regra de hoje deixa passar
---

O Jev ganha duas tarefas: **Perceber pedido para falar com uma pessoa** e **Perceber pedido para parar de receber mensagens**. Hoje quem percebe esses pedidos é uma regra sem IA: ela passa a conversa a uma pessoa quando o cliente escreve "quero falar com um atendente" (ou uma das palavras de passagem do agente) e bloqueia o contato quando ele manda "PARAR". Ela é precisa, mas estreita: "quero falar com alguém de verdade, não com robô" passa por ela sem ser visto.

O Jev só é perguntado **onde a regra de hoje disse não** — a mensagem que ela já pegou nem sai para a TypeSafe — e só onde o agente responderia: com um agente no ar atendendo a conversa, sem uma pessoa no comando, sem a conversa pausada, com o contato não bloqueado e fora de grupo. As duas perguntas vão juntas, numa chamada ao Jev separada da do clima da conversa: uma falha nela nunca muda a medição do clima.

As duas tarefas **só observam**: o Jev nunca passa a conversa, nunca bloqueia ninguém, nunca cala o agente nem responde o cliente — quem passa e quem bloqueia continua sendo a regra de hoje, ou uma pessoa. O cartão do Jev, em **IA › Provedores**, mostra quantos pedidos ele percebeu nos últimos 30 dias que a regra deixou passar, com links para as conversas mais recentes, para você ler o que o cliente escreveu. Em **IA › Execuções**, a chamada aparece como **"Perceber pedidos do cliente"**.

**Quem já tem o Jev ligado** vê as duas tarefas com o selo **"Nova"**, já observando: elas usam o mesmo dado que você já autorizou — cada mensagem, sozinha, sem CPF, telefone e e-mail. Isso é uma chamada a mais ao Jev por mensagem recebida em que a regra não viu pedido nenhum (uma fração de centavo de dólar, cobrada na sua conta da TypeSafe). Para não usar, clique em **"Pausar esta tarefa"** no cartão. A política de privacidade passa a listar essas duas finalidades. Nada precisa ser editado para atualizar.

Se a instalação voltar para uma versão anterior, as duas tarefas deixam de rodar lá e o estado delas fica guardado.
