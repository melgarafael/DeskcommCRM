---
impacto: nada_mudou
secao: corrigido
titulo: Testar do agente agora prepara a foto do produto como o envio real
---

Quando o agente testava uma resposta que usaria a foto de um produto, o teste olhava só o texto e dava como válido mesmo quando a foto não era encontrada no catálogo, não copiava ou não ficava pronta. Agora o teste prepara a foto do mesmo jeito que o envio de verdade prepara: procura o produto no catálogo, copia as fotos e só então avalia. Se a foto não ficar pronta, o teste é reprovado e diz o motivo; se o produto não tiver foto nenhuma, o texto segue com um aviso de que nenhuma imagem sairia.

Nada disso manda mensagem: o teste continua sem enviar nada e sem anexar arquivo em conversa de cliente. Ele grava o registro do teste, como já gravava, e agora também guarda no armazenamento uma cópia de cada foto testada, numa pasta de teste da organização. É uma cópia por foto, reaproveitada a cada novo teste; ela ocupa espaço do armazenamento e não é apagada sozinha.

O rascunho de resposta sugerido ao atendente usa a mesma prévia e passa pela mesma preparação: uma foto que não fica pronta deixa de virar resposta sugerida e, se nenhuma outra sobrar, o rascunho falha dizendo o motivo. Nenhum dado antigo muda e nada precisa ser feito ao atualizar.

Contribuição de @webtecnica (#2538, refs #2490), a partir da issue de @Fabricio-Point-Machine.
