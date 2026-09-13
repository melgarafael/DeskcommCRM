---
impacto: capacidade_nova
secao: corrigido
titulo: "Enviar link ao cliente" para de derrubar o banco
---

Um clique em **"Enviar link ao cliente"** levava o banco a **280% de CPU** e o pedido nunca voltava — a tela ficava girando e, no fim, dizia que deu erro. Reproduzido duas vezes numa instalação real.

O diagnóstico anterior estava **errado**. Achávamos que a causa era uma espera sem limite por uma trava interna. Medido durante o problema: **nenhuma trava estava segurada, ninguém estava esperando, e a função respondia em 2 milésimos de segundo** quando chamada direto.

A causa real: quando o sistema **recusa** o envio por um motivo definitivo (o compromisso mudou, o atendimento mudou, há um conflito que precisa de escolha), ele anunciava essa recusa com um código que significa, para as camadas de cima, *"foi um tropeço passageiro, tente de novo"*. E elas tentavam — **sem parar e a toda velocidade**.

Medido com a mesma peça e a mesma versão que rodam na VPS, com duas funções idênticas mudando só o código do aviso:

| Recusa anunciada como | Resposta | Vezes que rodou |
|---|---|---|
| definitiva | resposta em 12 milésimos | **1** |
| "tente de novo" | nunca respondeu | **51.556** |

Agora as três recusas definitivas da agenda dizem que são definitivas. A tela recebe a explicação de sempre, na hora, e o banco não é mais castigado.

**O que ainda NÃO está consertado, e está escrito de propósito:** o mesmo padrão existe em outros 80 pontos do sistema, fora da agenda (atendimento, follow-up, sincronização). Nenhum foi tocado nesta entrega, e um teste novo impede que apareçam outros — mas quem clicar num caminho desses ainda pode ver o mesmo travamento.
