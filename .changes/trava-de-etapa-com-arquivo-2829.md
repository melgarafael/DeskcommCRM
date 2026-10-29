---
impacto: nada_mudou
secao: corrigido
titulo: Trocar de funil ou retomar um negócio numa etapa que exige documento não é mais recusado para sempre
---

A troca de funil e a retomada criam o negócio no destino, mas conferiam a etapa como se ele já existisse e cobravam o arquivo do campo exigido. Só que o anexo pertence ao negócio e só pode ser enviado depois que ele nasce, então a resposta era sempre "falta o documento", e as duas operações nunca aconteciam.

Agora elas seguem a mesma regra da criação: entram na etapa, e o documento é cobrado na primeira movimentação (mover, mover em lote, ganhar ou perder), quando já dá para anexar.

A trava em si não mudou: mover para a etapa sem o arquivo naquele campo continua recusado, um valor em "campos personalizados" com o nome do campo não substitui o anexo, e arquivo em outro campo não libera a etapa. Nada a fazer na atualização. Contribuição de @webtecnica (#3627).
