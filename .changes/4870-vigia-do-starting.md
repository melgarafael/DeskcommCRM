---
impacto: capacidade_nova
secao: adicionado
titulo: A conexão presa em "Conectando…" passa a ser religada sozinha — e avisa quando não volta
---

A sessão do WhatsApp no canal não oficial podia ficar dias em "Conectando…" sem receber mensagem nenhuma, e o produto não avisava ninguém. O único sinal era a pausa da campanha de prospecção, que só existe para quem tem campanha ativa; quem não tinha descobria ao estranhar que ninguém escrevia.

Agora o vigia de sessão olha a idade do estado, não só o estado. Passados cinco minutos em "Conectando…" — sessenta vezes o pior boot medido, e portanto folga suficiente para um reinício normal terminar —, ele reinicia a sessão pelo próprio servidor de WhatsApp, sem descartar a credencial: é o mesmo stop e start do botão Reconectar, que não pede o QR de novo. As tentativas são espaçadas pelo mesmo prazo e param em três; se a sessão não voltar depois delas, o vigia para de insistir e a Central de avisos recebe o caso com o caminho para resolver à mão.

O aviso de saúde também passou a cobrir esse estado, pela mesma régua: "Conectando…" acima de cinco minutos aparece na Central como aviso, e sobe para crítico quando as tentativas automáticas se esgotam. Os dois consomem o mesmo prazo, o mesmo intervalo e o mesmo limite, então o que a tela diz e o que o sistema faz não podem divergir. Um boot normal — segundos, não minutos — continua em silêncio, e uma conexão que esteja funcionando nunca é reiniciada por esse caminho.

Os três números podem ser ajustados por instalação, em milissegundos para o prazo e o intervalo e em tentativas para o limite (`WHATSAPP_STARTING_PRAZO_MS`, `WHATSAPP_STARTING_INTERVALO_MS` e `WHATSAPP_STARTING_LIMITE`); sem eles, valem os padrões acima.

Crédito: @webtecnica.
