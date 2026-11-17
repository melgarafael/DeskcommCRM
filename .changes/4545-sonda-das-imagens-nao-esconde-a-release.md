---
impacto: nada_mudou
secao: corrigido
titulo: A sonda das imagens não esconde mais a atualização quando quem está fora é o registro, e o motivo vai para o log
---

O agente que oferece a atualização sonda as imagens publicadas antes de acender
o botão. Ele sondava as **quatro** imagens da release com prazo de vinte
segundos cada, e qualquer uma que não respondesse contava como "esta imagem não
foi publicada" — veredito `incompleta`, que zera a versão anunciada.

O problema é que `com_prazo 20` também devolve o mesmo silêncio quando o registro
está lento, quando a resposta é 429 do limite anônimo do GHCR ou quando a rede da
VPS oscila. Nesses casos a tela passa a dizer que a instalação está em dia,
porque o campo que libera o botão chega vazio — e, do lado de quem opera, não há
como ligar esse silêncio a um problema de rede. Numa VPS sem saída para o
registro, a atualização deixaria de ser oferecida para sempre.

Agora cada imagem tem a mesma sonda de controle que a imagem do app já tinha: se
a tag **instalada** também não responde, o que está fora é o registro, não a
imagem — o veredito vira `indisponivel`, que anuncia, e só a ausência provada
(a instalada responde e a nova não) continua escondendo a release.

E o motivo passou a ser registrado. Quando a release é escondida, o
`.update-agent.log` ganha uma linha dizendo qual versão deixou de ser anunciada,
qual imagem não respondeu e se ela estava `ausente` ou `indeterminada`. Antes, o
silêncio da tela não deixava rastro: a pergunta "por que não apareceu?" só podia
ser respondida lendo o código.

Crédito: @webtecnica.
