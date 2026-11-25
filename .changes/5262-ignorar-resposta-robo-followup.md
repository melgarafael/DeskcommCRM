---
impacto: nada_mudou
secao: corrigido
titulo: Follow-up com cancel_on_reply ignora respostas automáticas de robô
---

Quando `cancel_on_reply` está ativo em inscrições de follow-up, mensagens recebidas classificadas como menu numerado ou resposta automática de robô não cancelam mais a inscrição nem cortam o timer, registrando o evento `inbound_de_robo_ignorado` na trilha.
