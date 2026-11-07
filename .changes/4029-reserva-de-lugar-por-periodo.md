---
impacto: capacidade_nova
secao: adicionado
titulo: Reserva de lugar com capacidade em pessoas (mesa, camarote, quadra), pela API e desligada de fábrica
---

A agenda de serviço já reservava por período e já tinha teto de pessoas; o que
faltava era o **lugar**: um recurso com nome e área que a reserva ESCOLHE, e
não uma exigência de que todos estejam livres. Um recurso marcado como espaço
(`kind = 'space'`) passa a ser oferecido como mesa, camarote ou quadra, com
capacidade em pessoas, e a reserva grava qual lugar foi escolhido e quantas
pessoas vêm — **seis pessoas numa mesa de quatro agora são recusadas**, com a
mensagem "O número de pessoas passa da capacidade deste lugar."

**Vem desligado.** É o módulo opcional **Reservas de lugar**, que quem
administra o servidor liga em `/admin/sistema`. Desligado, criar um lugar
responde 404; os lugares e as reservas que já existem ficam guardados.
**Nesta versão não há tela nem atendimento pela IA:** o lugar é cadastrado e
reservado só pela API (`/api/v1/agenda/servicos` e `/api/v1/agenda/agendamentos`).
A tela de lugares e o painel do dia vêm em versões seguintes, atrás do mesmo
módulo.

A ocupação do lugar é contada em pessoas pelo máximo simultâneo do período, no
mesmo ponto que já contava a capacidade do serviço: a mesa é uma só, mesmo
quando dois serviços diferentes a oferecem. Cancelar a reserva libera a vaga, o
mesmo lugar em outro horário convive, e um grupo de seis numa mesa de quatro
não entra pela metade. Serviço sem lugar nenhum continua reservando exatamente
como antes.
