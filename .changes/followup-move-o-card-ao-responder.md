---
impacto: capacidade_nova
secao: adicionado
titulo: Follow-up de etapa pode mover o card quando o cliente responde
---

O gatilho de etapa já sabia **cancelar** quando o cliente respondia, mas não
sabia tirar o card da etapa: a regra de "mensagem recebida" carregava só o
contato, então mover o negócio era impossível de montar — e quem tentava
terminava com um card novo em vez do card que já existia.

Agora o gatilho de etapa tem, ao lado de "cancelar ao responder", a opção
**"quando o cliente responder, mover o card para a etapa X"**. O card movido é o
negócio aberto do contato **que está na etapa do gatilho** — o card que o fluxo
armou. As duas opções convivem: o card anda e a inscrição é encerrada na mesma
resposta. Contato sem negócio nessa etapa não abre card fantasma nem quebra a
automação, e quando o movimento é recusado (etapa arquivada ou removida) o
motivo fica na trilha da inscrição em vez de sumir em silêncio. Mensagem enviada
pela equipe não dispara — só a resposta do cliente.
