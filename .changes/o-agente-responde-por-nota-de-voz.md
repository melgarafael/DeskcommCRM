---
impacto: capacidade_nova
secao: adicionado
titulo: O agente pode responder por nota de voz (ElevenLabs)
---

Agora o agente pode responder ao cliente falando, não só escrevendo — a mesma voz,
escolhida por você, em toda conversa. Para ligar: cadastre e valide uma chave do
ElevenLabs em **Agente de IA → Credenciais**, escolha a voz em **Agente de IA → Provedores**
(dá para ouvir uma prévia antes de decidir), e ligue "Responder falando" na versão
do agente, em **Agente de IA → Editar agente**. Você escolhe
quando: sempre, nunca, ou só quando o cliente mandar áudio primeiro (o padrão).

Respostas com link ou longas continuam saindo em texto, para o cliente não perder
o link nem o fim da mensagem. Nas conexões pela API oficial do WhatsApp (e pelos
parceiros que seguem a mesma regra), por enquanto a resposta sai sempre em texto:
lá o áudio chegaria como anexo, não como nota de voz.

A mesma chave do ElevenLabs também pode ouvir os áudios do cliente: em
**Agente de IA → Provedores**, no ponto "Ouvir o áudio do cliente", escolha
**ElevenLabs (Scribe)**. O padrão continua sendo "Automático" — quem não escolher nada
segue transcrevendo como antes.

O texto que o agente escreveria continua existindo — a conversa não fica cega: a
busca, a exportação de dados e o classificador de follow-up continuam lendo
normalmente. O custo da síntese entra no mesmo orçamento mensal da organização
que já existe para o resto da inteligência artificial.

Nenhuma organização muda de comportamento com isto: o recurso nasce desligado em
toda versão existente, e continua desligado até você ligar os três passos acima.
