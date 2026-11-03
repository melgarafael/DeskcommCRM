---
impacto: capacidade_nova
secao: adicionado
titulo: O agente responde por nota de voz também no número oficial, e a resposta falada sai curta
---

Com "Responder falando" ligado, o agente agora fala também nas conexões pela API oficial do
WhatsApp e pelos parceiros que seguem a mesma regra. Antes, ali a resposta saía sempre em texto,
porque o áudio chegaria como anexo de música e não como nota de voz. Nesses números a síntese da
ElevenLabs passa a vir em OGG/Opus, o formato que a nota de voz deles exige; nas conexões pelo
celular pareado nada muda (segue em mp3, que ele converte). Se a ElevenLabs devolver o áudio em
outro formato, a resposta sai em texto, como já acontecia em qualquer falha da voz: o cliente
nunca fica sem resposta. Respostas com link ou longas continuam em texto.

E quando o agente vai responder por nota de voz, em qualquer número, agora ele sabe disso antes
de escrever: a resposta vem pensada para ser ouvida, curta (uns 20 segundos), uma ideia por vez,
sem listas, siglas nem símbolos. Antes ele escrevia como se fosse texto e a voz só lia, o que dava
áudios longos e cansativos. Nas respostas em texto nada muda. Áudio mais curto também gasta menos
caracteres de síntese. Crédito: @jmpo.
