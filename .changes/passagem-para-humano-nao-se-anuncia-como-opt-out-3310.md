---
impacto: nada_mudou
secao: corrigido
titulo: A passagem para humano deixa de ser anunciada como opt-out — e a escalação do próprio agente deixa de dizer que o cliente pediu uma pessoa
---

A pausa do atendimento automático e a escalação decidida pelo próprio agente passavam pela mesma porta do opt-out. Quem atende lia "O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele." para um cliente que apenas pediu ajuda — e o cliente recebia a abertura de quem pediu uma pessoa ("Sem problema. Acabei de acionar uma pessoa do time") quando quem pediu foi o agente, por não ter a informação ou por regra do prompt.

Agora a pausa por passagem para humano tem código próprio (`atendimento_com_humano`), família própria no aviso de retenção ("Resposta pausada: a conversa está com a equipe") e a frase que diz as duas coisas que a equipe precisa: que o automático está pausado porque a conversa foi passada para a equipe e que "Devolver ao automático" traz a IA de volta. O opt-out real continua com o código e as frases de hoje, bit a bit. O motivo `pediu_humano` (título do cartão e abertura enviada ao lead) passa a aparecer só quando o cliente pediu de fato; a escalação do agente (texto livre, ausência de motivo, falta de informação) é registrada como `low_confidence`, e a abertura enviada ao cliente usa a frase genérica. Quem usa agente externo pelo MCP: para o cartão dizer que o cliente pediu uma pessoa, envie `reason: "requested_human"`.

Nada muda no que o sistema decide: a pausa continua vetando os envios como antes (`force_human` segue irrevogável até "Devolver ao automático"), o opt-out real segue irrevogável, e nenhuma decisão de bloquear ou não bloquear foi tocada. A mudança é de texto e de código de aviso — nada a fazer na atualização.

Crédito: @webtecnica.
