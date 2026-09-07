---
impacto: nada_mudou
secao: corrigido
titulo: O endereço responde mesmo quando a hospedagem usa nomes próprios de porta
---

Em hospedagens com painel próprio (EasyPanel, entre outras), a instalação podia
terminar com tudo no ar por dentro e o endereço mostrando a página de erro do
painel: o instalador supunha os nomes que a hospedagem dá às portas 80 e 443, e
quando eles eram diferentes o roteamento simplesmente não acontecia — sem erro
em lugar nenhum.

Agora o instalador lê esses nomes da própria hospedagem e mostra quais
encontrou. Quem já tinha escolhido os nomes à mão continua com a escolha; quem
instalou antes e ficou com o endereço mudo pode rodar a instalação de novo para
que ela os detecte.
