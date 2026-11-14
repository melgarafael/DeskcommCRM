---
impacto: nada_mudou
secao: corrigido
titulo: Cancelar campanha avisa quando a fila não fechou, e cancelar de novo termina o serviço
---

Se o banco falhasse no meio do cancelamento de uma campanha, a tela dizia que tinha dado certo com "0 cancelados", enquanto quem ainda não tinha recebido continuava na fila — e a campanha, já cancelada, não aceitava cancelar de novo. Agora o erro aparece na hora, a campanha cancelada que ainda tem gente na fila mostra o botão "Cancelar campanha" outra vez, e repetir fecha o que sobrou. A data do cancelamento e quem já estava sendo enviado não mudam.

Crédito: @shu-chen-dot-ca.
