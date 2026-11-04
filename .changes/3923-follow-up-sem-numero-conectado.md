---
impacto: nada_mudou
secao: corrigido
titulo: Inscrever no follow-up sem número de WhatsApp conectado agora explica o que falta, em vez de dar erro
---

Numa instalação sem nenhum número de WhatsApp conectado, inscrever um contato num
fluxo de follow-up devolvia **500 sem corpo**: a tela só dizia "não foi possível
iniciar o follow-up" e não sobrava nada para o suporte ler. A recusa é do banco e
está certa — sem número não há conversa para abrir —, quem não a traduzia era a
rota.

Agora a resposta é 409 com o código `service_channel_not_found` e uma frase que
diz o que fazer: **"Conecte um número de WhatsApp antes de iniciar o
follow-up."** A tela mostra essa frase em vez do aviso genérico, no idioma de
quem está usando.

O mesmo módulo ganhou o piso de toque da casa nos botões de dia do horário de
envio do follow-up: eram 26 px de altura no celular e passam a 44 px. No
computador continuam compactos.

Contribuição de @webtecnica (#3923).
