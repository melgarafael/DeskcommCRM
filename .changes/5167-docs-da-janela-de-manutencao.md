---
impacto: nada_mudou
secao: corrigido
titulo: As docs de atualização contam a janela de manutenção da madrugada
---

O README prometia que a atualização pela tela "começa em até 5 minutos depois do clique" sem
mencionar a janela de manutenção, e o `docs/ATUALIZANDO.md` nem citava a tela. Agora os dois
explicam a `SYSTEM_UPDATE_WINDOW`: com ela configurada, o pedido feito fora da janela espera a
madrugada, a tela mostra "Atualização agendada para 02h00" e o pedido não se perde — roda
sozinho quando a janela abrir. A promessa dos 5 minutos ficou restrita ao caso sem janela.
