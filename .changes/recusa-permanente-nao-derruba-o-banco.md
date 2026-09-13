---
impacto: capacidade_nova
secao: corrigido
titulo: "Enviar link ao cliente" para de derrubar o banco
---

Um clique em **"Enviar link ao cliente"** levava o banco a **280% de CPU** e o pedido nunca voltava — a tela girava e terminava em erro. Reproduzido duas vezes numa instalação real.

A causa: quando o sistema recusava o envio por um motivo **definitivo** (o compromisso mudou, o atendimento mudou), ele anunciava a recusa como se fosse um tropeço passageiro. As camadas de cima acreditavam e tentavam **sem parar**.

Medido com a mesma peça e versão da VPS: a mesma recusa anunciada como definitiva responde em 12 milésimos e roda **uma** vez; anunciada como passageira, nunca responde e roda **51.556** vezes.

**O que ainda NÃO está consertado:** o mesmo padrão existe em outros 80 pontos do sistema, fora da agenda. Nenhum deles foi tocado nesta entrega, e um teste novo impede que apareçam outros — mas quem clicar num caminho desses ainda pode ver o mesmo travamento.
