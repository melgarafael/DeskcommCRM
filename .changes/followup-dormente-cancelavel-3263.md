---
impacto: nada_mudou
secao: corrigido
titulo: Cancelar um acompanhamento que espera a vez do contato encerra de verdade, em vez de dizer que já acabou
---

Na fila de follow-ups, um acompanhamento que estava esperando a vez do contato (a espera longa que evita dois fluxos disputarem o mesmo contato) aparecia com o botão de cancelar, mas o clique respondia "Enrollment já está encerrado" (409) e a inscrição continuava de pé. Agora o cancelamento encerra de verdade: a inscrição vira cancelada, com motivo manual e sem próxima avaliação, e essa espera não volta a acordar. O que já tinha acabado por conta própria (concluído, cancelado, morto) segue recusando o cancelamento com o mesmo 409. Nada a fazer na atualização.
