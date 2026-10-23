---
impacto: nada_mudou
secao: corrigido
titulo: O divisor da lista aproveita o espaço do painel do contato recolhido
---

Com o painel do contato recolhido (o trilho estreito do botão de expandir), a conversa ganhava a largura que era da ficha, mas o divisor da lista continuava limitado como se a ficha estivesse aberta: arrastar a lista não aproveitava nada do espaço liberado. Agora o divisor consulta o estado real do painel — recolhido, o máximo arrastável da lista é maior e chega ao teto próprio da lista. Com o painel aberto o comportamento é exatamente o de antes: as larguras continuam limitadas pelo piso da conversa, a largura salva por faixa continua sendo restaurada da mesma forma e a chave de armazenamento não muda. Nada a fazer na atualização.

Contribuição de @webtecnica (#3152).
