# Conferência do registro no envio

Resgate creditado a @webtecnica, fonte #3529 no head literal
`83e8e198b3345ab10906a1c99c032a1c92d3c6a8`. A main
`9785581cdb1242802c18f86e331ade8dcb4afa42` foi composta por merge normal.

O contrato desta entrega é limitado: **sem nenhum efeito confirmado da
ferramenta neste turno, uma afirmação correspondente é recusada**. O coletor é
por nome de ferramenta; ele não identifica o objeto afirmado. Refs #3333, que
permanece aberta. O R5 do banco externo (#3328) não foi incorporado neste lote.

## Reparo e prova causal

O turno entregava `registro` ao objeto de argumentos, mas `runBeforeSend`
reconstruía seu `GateContext` sem repassar esse campo. O gate via ausência e
passava. Agora o argumento é tipado e o mesmo coletor chega ao contexto.

`registro-no-envio-real.test.ts` executa o `runBeforeSend` real, com a cadeia
padrão, pool e transporte controlados. Não simula o gate nem o runner. Sem
tentativa, com falha e com incerteza, a afirmação é vetada e o transporte fica
com zero chamadas. O controle com efeito confirmado envia a mesma frase uma
vez. Isso não é prova de PostgreSQL, WAHA ou de gravação de um negócio real.

O primeiro RED teve seis falhas e trinta controles verdes: três envios indevidos,
dois futuros/possibilidades recusados no gate puro e a contagem antiga do painel.
Depois de corrigir só a fiação, o segundo RED teve duas falhas e quatro controles
verdes na cadeia real: “será registrado” e “pode ser registrado” eram vetados.
O padrão de particípio passou a exigir estado afirmado no presente/passado.

O painel confere o conjunto nominal das conferências sem interruptor, incluindo
todos os nomes antigos e `registro_sem_efeito`. Ele continua exigindo a razão
visível de cada uma. Uma troca de nomes com a mesma contagem também reprova.

O conjunto focado passou com 82 casos em sete arquivos, um worker. A prova
controlada complementa os testes puros e as cercas de fonte do autor; não
substitui o CI do head publicado nem mede um turno completo com modelo.

A prova visual específica passou no caso existente “o papel que confere
mostra a lista inteira, aberta, e sem interruptor decorativo”, em
`agente-papeis-operador.spec.ts`, no [job da parte 1](https://github.com/melgarafael/DeskcommCRM/actions/runs/40499697633/job/122174067862)
do head `1041c3e7`: 1,9 segundo, com login e agente semeado reais. O caso
confere a linha, o motivo fixo e zero interruptores, sem `page.route`.

A captura real da linha fixa está em `evidence/registro-no-envio/linha-fixa.png`.

O PNG é a captura original do elemento após as asserções, sem edição. O
[recibo de origem](../../evidence/registro-no-envio/origem.json) registra head,
checkout, run, job, artefato e SHA256. A imagem prova a linha renderizada;
não mede um turno completo nem efeito por objeto. Os cinco checks do próximo
head continuam necessários; o verde desta parte não encerra a composição.

## Lacuna mantida na issue

Um turno pode chamar `crm_create_lead` para títulos ou funis diferentes. Se A
produz efeito e B falha, o mapa monotônico continua indicando efeito para esse
nome. Assim, a presença de efeito não comprova uma afirmação sobre B. Essa
lacuna permanece na #3333; não há nova expectativa verde que trate tal afirmação
como correta. Identidade por objeto exige um contrato próprio e ficou fora
deste reparo incremental.
