---
impacto: capacidade_nova
secao: adicionado
titulo: Chat no site: janela, código para colar e aba de conexão (desligados de fábrica)
---

O canal "Chat no site" (Spec 36, F2-A) chega ao produto: a janela `/chat/<chave>`, o script
da bolha `public/webchat.js` e a aba "Chat no site" em Conexões. Quem tem um site cola uma
linha de código e a janela aparece para o visitante; a conversa cai no Inbox com o selo do
canal.

O módulo `canal_webchat` nasce DESLIGADO de fábrica: nenhuma organização que não o ligar
vê diferença — não há rota pública, nem script servido, nem aba em Conexões. A opção de
ligar só será liberada quando existirem a barreira de site e o limite de respostas da IA
para visitante anônimo (ainda por vir). Até lá, não prometa chat funcionando.

Como o módulo vem desligado, não há ação requerida de quem já opera uma instalação.

Contribuição de @paulolimajr77.
