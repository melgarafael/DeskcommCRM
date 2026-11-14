---
impacto: capacidade_nova
secao: adicionado
titulo: Robô do Telegram como canal opcional, desligado por padrão
---

Quem administra o servidor pode ligar, em Administração › Sistema, o módulo
"Robô de mensagens (@BotFather)". Ligado, cada empresa ganha em Conexões uma
aba para conectar um robô do Telegram colando o token que o @BotFather mostra.
As conversas privadas com o robô chegam ao Inbox e a resposta sai pelo mesmo
robô, só em texto. Grupos, mídia e campanhas não passam por este canal. Um
robô que já atende em outra conta é recusado antes de qualquer mudança nele.
Desligado (o padrão), nada muda para quem já usa o sistema, e nenhuma variável
nova é exigida no `.env`. Contribuição de @webtecnica (#3486), sobre a proposta
de @SPYDeEp1 (#3440).
