---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem enviada pelo CRM não aparece mais duas vezes nas conversas individuais com o motor WEBJS
---

Nas conexões WhatsApp com o motor WEBJS, uma mensagem mandada pelo CRM ou pelo agente às vezes aparecia duas vezes numa conversa individual: a do envio e o eco que o WhatsApp devolve. O motivo era que as duas linhas guardavam o mesmo identificador escrito de jeitos diferentes, e a proteção do banco contra duplicata não reconhecia que era a mesma mensagem. Agora o envio guarda o identificador no mesmo formato do eco, e a proteção passa a valer.

Nos grupos e no motor padrão (NOWEB) nada muda. Mensagens antigas continuam recebendo os avisos de entregue e lida normalmente, e nada precisa ser feito ao atualizar.

Contribuição de @webtecnica (#2525, refs #196).
