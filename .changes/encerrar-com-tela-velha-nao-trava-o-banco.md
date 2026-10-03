---
impacto: nada_mudou
secao: corrigido
titulo: Encerrar uma conversa com a tela desatualizada não deixa mais o CRM lento
---

Quando alguém encerrava, arquivava ou reabria uma conversa que outra pessoa (ou o agente) já tinha mexido, o CRM recusava a ação — o certo — mas a recusa era tratada pelo servidor como um conflito passageiro e repetida sem parar, em segundo plano, mesmo depois de a tela desistir. Em instalações com o Supabase na própria VPS, isso chegou a ocupar o processador inteiro e deixar o CRM lento para todos os usuários. Agora a recusa sai como "o atendimento mudou, atualize e tente de novo" e nada fica repetindo.

Não é preciso fazer nada na instalação: a atualização troca a função do banco sozinha.

Contribuição de @AlecsanderAbreu.
