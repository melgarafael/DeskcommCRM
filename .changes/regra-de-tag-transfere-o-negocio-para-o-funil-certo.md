---
impacto: nada_mudou
secao: corrigido
titulo: A regra "criar ou mover negócio" agora transfere o card quando o gatilho é uma etiqueta de negócio
---

Quando uma regra de automação de gatilho "etiqueta adicionada ao negócio" apontava para um funil diferente daquele onde o card estava, a ação "criar ou mover negócio" recusava com `cross_pipeline_move_not_allowed` e nada acontecia: a regra acumulava execuções zeradas e o card continuava parado no funil de entrada, sem etapa, follow-up por etapa nem relatório do funil do produto. Ela recusava justamente porque o evento traz o negócio junto — e o caminho que transfere (clona o card para o funil da regra e encerra o de origem como transferência, sem contar como perda comercial) só rodava quando o evento não trazia o negócio.

Agora, com gatilho "etiqueta adicionada ao negócio" e funil de destino diferente, a ação usa esse mesmo caminho: o card nasce no funil de destino com título, contato, valor, tags e campos personalizados da origem, o de origem é encerrado com o motivo de transferência e as próximas ações da regra enxergam o card novo. O card troca de funil no máximo uma vez a cada aplicação de etiqueta: se duas regras desse gatilho apontarem para funis diferentes no mesmo evento, vale a primeira, e a segunda aparece na aba Atividade com o motivo, sem transferir de novo. Os demais gatilhos que trazem o negócio (criação, troca de etapa, datas) continuam recusando mover entre funis, como antes.

Nada precisa ser feito na instalação: quem já tem uma regra dessas vê o card passar a ir para o funil certo assim que a etiqueta for aplicada. O caso em que o roteador de intenção classifica a mensagem sem que a equipe de recepção chegue a etiquetar continua fora do alcance desta correção e é o outro pedaço da mesma issue.

Contribuição de @webtecnica, na issue #2155 e no PR #2162.
