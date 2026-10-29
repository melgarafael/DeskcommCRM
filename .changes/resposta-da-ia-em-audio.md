---
impacto: capacidade_nova
secao: adicionado
titulo: A IA pode responder em áudio quando o cliente pede ou diz que não consegue ler
---

Na tela do agente, a opção «Responder em áudio quando o cliente pedir» faz a IA
mandar a resposta como nota de voz quando o cliente pede áudio («manda um áudio»,
«responde por áudio») ou diz que não consegue ler. A preferência vale para a
conversa até o cliente pedir texto de novo. O texto da resposta fica guardado na
conversa, abaixo do áudio. A voz é a do Google Cloud Text-to-Speech em português
do Brasil: a chave se cadastra, testa, substitui e remove em IA › Provedores ›
Voz e áudio (fica cifrada; a tela mostra só os 4 últimos caracteres), onde dá
para ouvir uma amostra de cada voz. Cada agente escolhe a sua voz, entre as
vozes Standard em português do Brasil (as de menor custo; as outras famílias
não são oferecidas nem aceitas). Sem chave a opção não liga; se a voz falhar, a
resposta sai em texto, como antes. A opção nasce desligada. As variáveis
`GOOGLE_TTS_API_KEY` e `GOOGLE_TTS_VOICE` continuam valendo como reserva da
instalação. Crédito: @joao-v-nt.
