---
impacto: capacidade_nova
secao: adicionado
titulo: Voltar para a versão anterior em um clique, e o sistema volta sozinho quando o app cai depois de uma atualização
---

Quando uma atualização terminava e o site não voltava, havia um único caminho de saída: abrir o terminal no servidor e copiar o comando que a tela mostrava. Agora são dois, e nenhum dos dois pede terminal.

Se o painel está de pé — a atualização falhou, mas o site ainda responde —, a tela de Atualização passa a mostrar o botão "Voltar para a versão anterior" ao lado do comando de antes. O botão leva o sistema para a versão de onde a tentativa saiu, nunca para a última publicada, que é justamente a que acabou de quebrar; o site fica fora do ar por cerca de 2 minutos e volta em seguida. Os seus dados seguem intactos: a cópia de segurança feita antes da tentativa continua guardada no servidor. O comando continua visível como plano B, para quem prefere o terminal.

Se o painel NÃO está de pé — o site respondeu erro e o próprio botão mora dentro do app que parou —, o agente do host cuida disso sozinho. É o mesmo agente que executa as atualizações de 5 em 5 minutos: logo após uma atualização, se o site não responder duas vezes seguidas, ele mesmo volta para a versão anterior e escreve no log o que houve e por quê. A proteção só existe nas duas horas seguintes à atualização e dispara uma única vez: uma queda dias depois, ou por motivo alheio à versão, não põe o sistema para trocar de versão sozinho.

Você não precisa fazer nada.

Contribuição de @webtecnica, a partir da issue #2757.
