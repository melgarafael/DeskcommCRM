---
impacto: capacidade_nova
secao: adicionado
titulo: Reserva de lugar com capacidade por período (mesa, camarote, quadra)
---

A agenda de serviço já reservava por período e já tinha teto de pessoas; o que
faltava era o **lugar**: um recurso com nome e área que a reserva ESCOLHE, e
não uma exigência de que todos estejam livres. Um recurso marcado como espaço
(`kind = 'space'`) passa a ser oferecido como mesa, camarote ou quadra, com
capacidade em pessoas, e a reserva grava qual lugar foi escolhido e quantas
pessoas vêm — **seis pessoas numa mesa de quatro agora são recusadas**, com a
mensagem "O número de pessoas passa da capacidade deste lugar."

A ocupação do lugar é contada em pessoas ao longo de todo o período, no mesmo
ponto que já contava a capacidade do serviço: a mesa é uma só, mesmo quando dois
serviços diferentes a oferecem. Cancelar a reserva libera a vaga, o mesmo lugar
em outro horário convive, e um grupo de seis numa mesa de quatro não entra pela
metade. Serviço sem lugar nenhum continua reservando exatamente como antes.
