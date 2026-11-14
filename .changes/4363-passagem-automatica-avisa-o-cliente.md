---
impacto: capacidade_nova
secao: adicionado
titulo: A troca automática de agente avisa o cliente, com a frase do roteador
---

Quando o classificador do roteador troca quem atende — o cliente escreve algo da intenção de outro agente e a próxima resposta já vem dele —, o cliente agora pode receber uma frase avisando da passagem. A frase é escrita por vocês, na tela do roteador (campo "Mensagem de passagem ao cliente"), e sai uma vez só, antes da resposta do agente novo, no idioma em que vocês atendem.

Vem **desligada**: com o campo vazio, nada muda — a troca continua silenciosa e o agente novo se apresenta com as palavras dele. Ligada, o agente novo é instruído a não repetir o aviso, para o cliente não ler duas passagens na mesma troca.

O aviso sai pela mesma cadeia de guardrails de tudo o que o produto envia (opt-out, janela de mensagem, limites do número): se a cadeia vetar, a conversa troca de agente do mesmo jeito e o agente novo se apresenta, como hoje.

A passagem explícita — o agente passando a conversa por decisão própria — não usa esta frase: lá quem avisa o cliente é o próprio agente, na resposta dele. Continua exatamente como era.

Crédito: @webtecnica.
