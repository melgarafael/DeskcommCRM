---
impacto: nada_mudou
secao: corrigido
titulo: Em 320 px o topo do celular para de sobrepor o botão Buscar ao seletor de organização
---

Em 320 px de largura o topo do celular não tinha mais espaço para a coluna da busca: ela encolhia a 0 px e o botão Buscar (42 px) passava 13 px por cima do seletor de organização e 13 px por cima do sino da Central de avisos. De 360 px para cima a conta fechava.

Agora, abaixo de 360 px, o botão de tema sai do topo (o idioma, a navegação e os avisos ficam — o tema segue a preferência do sistema e a escolha salva continua valendo) e a coluna da busca ganha piso de 44 px, a mesma largura de um alvo de toque. Medido por `getBoundingClientRect` em viewport emulado: em 320 px o seletor de organização termina 9 px antes do botão Buscar, que termina 9 px antes do sino, e a coluna da busca tem 44 px.

De 360 px para cima nada muda: as posições e as larguras do seletor de organização, do botão Buscar, do sino e da coluna da busca são idênticas às de antes, em 360 px e em 375 px. O nome da organização continua no `aria-label` do seletor e o botão de busca continua com nome acessível.
