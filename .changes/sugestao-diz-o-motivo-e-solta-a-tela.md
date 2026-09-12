---
impacto: capacidade_nova
secao: corrigido
titulo: A sugestão de resposta diz por que falhou, e a rejeitada sai da tela
---

Duas coisas na caixa de entrada, medidas numa instalação real.

**A sugestão rejeitada não saía da tela.** O painel mostrava a sugestão mais recente sem olhar a situação dela — e uma rejeitada continua sendo a mais recente. O texto ficava ali, numa caixa desabilitada, sem botão de fechar (não havia nenhum). Pior no caso comum: quem rejeita costuma pedir outra em seguida; se essa segunda falha, nada substitui a primeira e a tela **trava** naquele texto.

Agora a sugestão rejeitada — e também a obsoleta e a já enviada — solta o painel, que volta ao botão **Sugerir resposta**. A sugestão que falhou continua aparecendo de propósito: a frase dela é a única pista que sobra.

**O erro não dizia nada.** Qualquer falha ao gerar virava a mesma frase — "Confira a publicação e a configuração do agente" —, mesmo quando o problema era outro, e **o motivo real era descartado sem ser registrado**. A tela ainda mostrava o identificador da requisição junto, o que fazia a mensagem parecer rastreável: não era, porque não havia nada gravado para procurar.

Agora a tela diz qual dos motivos foi — nenhum agente publicado atende o canal, ou a conversa não pode receber sugestão (contato que pediu para não receber mensagens, contato anonimizado, histórico ilegível) — e, quando a causa é outra, admite que é outra e **registra** no servidor, onde o identificador finalmente encontra alguma coisa.

Nada muda para quem opera: sem passo manual, sem mexer em configuração.
