---
impacto: nada_mudou
secao: corrigido
titulo: A limpeza automática do arquivo de webhooks não trava mais quando há atraso acumulado
---
A poda pedia 500 itens de uma vez num endereço longo demais: com algumas centenas de linhas vencidas acumuladas, o endereço passava do limite do gateway e a limpeza parava na mesma leva para sempre, deixando o banco crescer sem teto (numa instalação medida, ~23 MB/dia). Agora o lote é cortado por data, e a poda esvazia o corpo das linhas vencidas como prometido. Nada muda na configuração.

Contribuição de @Sandersono.
