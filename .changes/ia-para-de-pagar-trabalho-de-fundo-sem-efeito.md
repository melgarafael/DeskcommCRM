---
impacto: nada_mudou
secao: alterado
titulo: A IA para de gastar com trabalho de fundo que não muda nada
---
Três rotinas de fundo da IA pagavam o modelo ou consultavam o banco mesmo quando o resultado não tinha como ser usado. Agora não pagam mais.

- **Clima da conversa (sentimento):** deixa de ser medido nas conversas em que a IA não pode atender, porque uma pessoa da equipe está no comando, a conversa foi silenciada ou o contato foi passado a humano. Nessas conversas o aviso de cliente irritado já era descartado antes de chegar a alguém. Nas conversas que a IA atende, o clima continua sendo medido a cada mensagem e continua chamando uma pessoa quando o cliente se irrita. A medição também saiu de dentro do recebimento da mensagem e passou para o processamento de fundo, que a pega pelo menos 15 segundos depois, o mesmo prazo dos avisos de caso e de proposta. Por isso o aviso de cliente irritado pode chegar à equipe um pouco depois de antes. Assim, o recebimento da mensagem e o início da resposta do agente deixam de esperar pela chamada ao modelo do clima. Uma consequência: a nota de clima das mensagens dessas conversas deixa de ser gravada, então a comparação do cartão do Jev passa a usar só as conversas que a IA atende.
- **Respostas do agente antigo:** a rotina que só existe para empresas com agente antigo, sem versão publicada, agora confere isso primeiro. Quem já usa agente publicado sai dela com uma consulta ao banco por mensagem. Quem ainda tem o agente antigo mantém tudo como estava, inclusive a passagem para humano quando o cliente pede uma pessoa.
- **Avaliação automática das conversas (flywheel):** a rodada agendada não avalia de novo atendimentos que já têm avaliação, pega só um atendimento por contato e olha só os atendimentos recentes, até o dobro do intervalo entre rodadas. Uma rodada sem atendimento novo não chama o modelo nenhuma vez.

Não é preciso fazer nada na instalação.
