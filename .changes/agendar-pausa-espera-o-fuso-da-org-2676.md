---
impacto: nada_mudou
secao: corrigido
titulo: Agendar pausa espera o fuso da organização antes de gravar
---

O diálogo "Agendar pausa" das Conexões convertia a hora digitada pelo fuso padrão (São Paulo) enquanto o GET `/api/v1/channel-schedules` ainda não tinha respondido. Organização em outro fuso — `America/Manaus`, por exemplo — que agendasse nesse intervalo gravava a pausa com uma hora de diferença, sem nenhum aviso na tela (#2676).

Agora não existe fuso padrão no cliente: enquanto o fuso não chega, os campos de data/hora e o botão "Agendar" ficam travados, e um clique forçado não vira payload nenhum. Se o GET falhar, o diálogo mostra o motivo em vermelho em vez de gravar na hora errada. Quando o fuso chega, tudo habilita e a conversão é a mesma de sempre — no fuso da organização, lido do banco.

A partir da issue #2676, da triagem da tela do #2673.
