---
impacto: capacidade_nova
secao: adicionado
titulo: Voltar para a versão anterior em um clique, e o sistema volta sozinho quando o app cai depois de uma atualização
---

Quando uma atualização terminava e o site não voltava, havia um único caminho de saída: abrir o terminal no servidor e copiar o comando que a tela mostrava. Agora são dois, e nenhum dos dois pede terminal.

Se o painel está de pé — a atualização falhou, mas o site ainda responde —, a tela de Atualização passa a mostrar o botão "Voltar para a versão anterior" ao lado do comando de antes. O botão leva o sistema para a versão de onde a tentativa saiu, nunca para a última publicada, que é justamente a que acabou de quebrar; o site fica fora do ar por cerca de 2 minutos e volta em seguida. Os seus dados seguem intactos: a cópia de segurança feita antes da tentativa continua guardada no servidor. O comando continua visível como plano B, para quem prefere o terminal.

Se o painel NÃO está de pé — o site respondeu erro e o próprio botão mora dentro do app que parou —, o agente do host cuida disso sozinho. É o mesmo agente que executa as atualizações de 5 em 5 minutos: nas duas horas seguintes a uma atualização, se o site não responder duas vezes seguidas, ele mesmo volta para a versão anterior.

"Não responder" quer dizer que quem atendeu o endereço não foi o sistema: conexão recusada, tempo esgotado, ou o erro de um proxy na frente dele (502, 504, ou a página de rota perdida). Um serviço interno fora do ar — o WhatsApp, o cache ou o banco — **não** dispara a volta: nesse caso o sistema responde, mesmo que seja para avisar do problema, e a atualização fica como está. A volta acontece uma única vez, e só dentro dessas duas horas: uma queda dias depois, ou por motivo alheio à versão, não põe o sistema para trocar de versão sozinho. Quando ela acontece, a tela de Atualização conta o que houve — para qual versão o sistema voltou, a que horas, e por quê.

Você não precisa fazer nada.

Contribuição de @webtecnica, a partir da issue #2757.
