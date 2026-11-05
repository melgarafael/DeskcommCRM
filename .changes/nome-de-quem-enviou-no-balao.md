---
impacto: capacidade_nova
secao: alterado
titulo: O balão da conversa mostra o nome de quem da equipe enviou
---

A mensagem enviada por uma pessoa da equipe passa a sair como **Atendente · Andreia** em vez de só "Atendente" — o mesmo formato que a IA já usava ("IA · Clara"). O primeiro nome basta, e quem escreveu continua vendo "Você": com duas consultoras na mesma conversa, o gestor agora sabe quem prometeu o quê. O nome é resolvido na leitura do histórico, uma vez por página, a partir do `sent_by_user_id` que já era gravado; sem nome resolvido (usuário removido, instalação sem service role, mensagem antiga) a tela continua dizendo "Atendente", sem quebrar. Mensagem recebida do cliente e envio pelo celular não ganham esse rótulo. Crédito: @aerosuiteapp.
