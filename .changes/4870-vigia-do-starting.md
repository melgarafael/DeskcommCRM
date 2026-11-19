---
impacto: capacidade_nova
secao: adicionado
titulo: A conexão presa em "Conectando…" passa a ser religada sozinha — e avisa quando não volta
---

A sessão do WhatsApp no canal não oficial podia ficar dias em "Conectando…" sem receber mensagem nenhuma, e o produto não avisava ninguém. O único sinal era a pausa da campanha de prospecção, que só existe para quem tem campanha ativa.Agora o vigia de sessão olha a idade do estado, não só o estado. Passados cinco minutos em "Conectando…", ele reinicia a sessão pelo próprio servidor de WhatsApp, sem descartar a credencial: é o mesmo stop e start do botão Reconectar, que não pede o QR de novo. As tentativas são espaçadas pelo mesmo prazo e param em três; se a sessão não voltar, o vigia para de insistir e a Central de avisos recebe o caso com o caminho para resolver à mão.

O aviso de saúde cobre o mesmo estado pela mesma régua: "Conectando…" acima de cinco minutos aparece na Central e sobe para crítico quando as tentativas se esgotam. Um boot normal continua em silêncio, e uma conexão que esteja funcionando nunca é reiniciada por esse caminho.

Prazo, intervalo e limite podem ser ajustados por instalação (`WHATSAPP_STARTING_PRAZO_MS`, `WHATSAPP_STARTING_INTERVALO_MS` e `WHATSAPP_STARTING_LIMITE`); sem eles, valem os padrões acima.

Crédito: @webtecnica.
