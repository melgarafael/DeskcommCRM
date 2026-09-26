---
impacto: capacidade_nova
secao: adicionado
titulo: O Jev passa a perceber quando o cliente pede para falar com uma pessoa ou para parar de receber mensagens, e pode avisar a equipe na Central
---

O Jev ganha duas tarefas: **Perceber pedido para falar com uma pessoa** e **Perceber pedido para parar de receber mensagens**. Hoje quem percebe esses pedidos é uma regra sem IA: ela passa a conversa a uma pessoa quando o cliente escreve "quero falar com um atendente" (ou uma das palavras de passagem do agente) e bloqueia o contato quando ele manda "PARAR". Ela é precisa, mas estreita: "quero falar com alguém de verdade, não com robô" passa por ela sem ser visto.

O Jev só é perguntado **onde a regra de hoje disse não** — a mensagem que ela já pegou nem sai para a TypeSafe — e só onde o assistente de fato responderia: o número da conversa tem um agente publicado (ou um roteador ativo com um agente publicado), nenhuma pessoa está com a conversa nem com outra conversa do mesmo cliente, o contato não está bloqueado e não é grupo. Pedido mandado por áudio não é perguntado. As duas perguntas vão juntas, numa chamada ao Jev separada da do clima da conversa: uma falha nela nunca muda a medição do clima.

As duas tarefas **começam só observando**. O cartão do Jev, em **IA › Provedores**, mostra quantos pedidos ele percebeu nos últimos 30 dias que a regra deixou passar, com links para as conversas mais recentes, para você ler o que o cliente escreveu. Em **IA › Execuções**, a chamada aparece como **"Perceber pedidos do cliente"**.

Quando quiser, clique em **"Avisar a equipe"** na tarefa (o cartão explica o efeito e pede confirmação antes de valer). A partir daí, cada pedido que o Jev perceber abre **um aviso na Central de avisos**, um por conversa, com o botão **"Abrir a conversa"**; se o cliente pedir de novo depois de o aviso ser resolvido, o mesmo aviso volta a abrir. O aviso não repete o que o cliente escreveu — a mensagem fica na conversa, para quem pode vê-la — e se fecha sozinho quando a conversa passa para uma pessoa (por qualquer caminho: alguém assume, o atendimento automático a passa, ou ela é encerrada); o de parar de receber também se fecha quando o contato é bloqueado. O "Marcar resolvido" continua valendo. Com as tarefas avisando, o cartão segue dizendo que o Jev **observa**: ele não decide nada no lugar da regra. Em nenhum estado o Jev passa a conversa, bloqueia alguém, cala o agente ou responde o cliente: quem passa e quem bloqueia continua sendo a regra de hoje, ou uma pessoa. Para voltar, clique em **"Voltar a só observar"**.

**Quem já tem o Jev ligado** vê as duas tarefas com o selo **"Nova"**, já observando: elas usam o mesmo dado que você já autorizou — cada mensagem, sozinha, sem CPF, telefone e e-mail. Isso é uma chamada a mais ao Jev por mensagem recebida em que a regra não viu pedido nenhum (uma fração de centavo de dólar, cobrada na sua conta da TypeSafe). Para não usar, clique em **"Pausar esta tarefa"** no cartão. A política de privacidade passa a listar essas duas finalidades. Nada precisa ser editado para atualizar.

Se a instalação voltar para uma versão anterior, as duas tarefas deixam de rodar e o estado delas fica guardado; os avisos já abertos continuam na Central, e seguem se fechando sozinhos.
