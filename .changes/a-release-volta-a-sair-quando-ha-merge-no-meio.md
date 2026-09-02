---
impacto: nada_mudou
secao: corrigido
titulo: A atualização volta a chegar quando alguém aprova outra coisa durante o fechamento da versão
---

Uma versão do sistema é fechada em duas etapas: primeiro o time monta a lista do
que entrou, depois aprova essa lista. Entre uma coisa e outra, qualquer outra
melhoria aprovada no meio do caminho fazia o fechamento **desistir em silêncio**
— a versão aparecia na lista de novidades, mas nunca era publicada de verdade.

O efeito para quem tem o sistema instalado era o pior tipo: nada de errado
aparecia em lugar nenhum. O painel não acusava, o histórico de versões mostrava
a versão nova como se existisse, e a atualização simplesmente nunca chegava. Foi
o que aconteceu com a versão 1.11.1: ela consta no histórico desde 31 de agosto e
nunca existiu como pacote — nenhuma instalação a recebeu.

Agora o fechamento reconhece a si mesmo por outro sinal, que não depende de o
resto do time parar de trabalhar enquanto a versão fecha. E, se alguma coisa
estranha acontecer nesse momento, o processo **falha alto** em vez de passar
batido — que é o que teria feito alguém perceber a 1.11.1 no mesmo dia, e não
duas semanas depois.

Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
nova, nenhum passo de atualização. O que muda é que "a versão saiu" volta a
significar que ela saiu.
