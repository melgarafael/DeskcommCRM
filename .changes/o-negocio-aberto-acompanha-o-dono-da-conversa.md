---
impacto: nada_mudou
secao: corrigido
titulo: Transferir a conversa leva o negócio aberto do cliente também fora da tela
---
Transferir uma conversa já levava o negócio aberto do cliente para o novo responsável, mas só quando a transferência era feita pela tela. Pela integração com IAs (MCP) ou por chamada direta, a conversa mudava de dono e o negócio ficava com quem não atende mais. Agora a regra mora no banco, na mesma operação da troca de dono. Contribuição de @webtecnica (issue #4019).

O que não muda, de propósito: só a **transferência** tira o negócio de outra pessoa. Assumir a conversa, iniciar conversa, a distribuição automática da fila e a passagem para um humano só dão dono a um negócio que estava **sem responsável** — nunca tiram o negócio de um colega. O mesmo vale para trocar a carteira do cliente e para passar as conversas do contato a outra pessoa: a conversa muda de dono, e o negócio que já tem responsável fica onde está. Quem transfere pela tela continua dentro da própria permissão: com a visibilidade padrão, o Atendente que transfere para uma colega não leva o negócio junto. Só um negócio aberto é levado; cliente sem negócio aberto não ganha card novo, e com mais de um aberto nada é tocado. Nenhuma configuração a fazer.
