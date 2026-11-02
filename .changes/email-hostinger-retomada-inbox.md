---
impacto: capacidade_nova
secao: corrigido
titulo: A sincronização retoma mensagens que ficaram com efeitos pendentes
---

Se o worker cair depois de gravar um e-mail, a próxima sincronização retoma o carimbo da conversa e o despacho da Zoe sem inserir a mensagem outra vez. A gravação do estado pendente acompanha a mensagem; um despacho já registrado não é duplicado. Linhas antigas sem marcador não são reprocessadas. A integração continua desligada até o administrador configurar a caixa e ativar a sincronização.
