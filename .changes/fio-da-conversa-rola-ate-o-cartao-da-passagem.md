---
impacto: nada_mudou
secao: corrigido
titulo: O fio da conversa volta a rolar até o fim quando o cartão de passagem chega antes das mensagens
---

Quem abria uma conversa recém-passada para humano às vezes via o cabeçalho do
cartão "Por que a IA passou para você", mas o convite "Assumir e responder"
ficava montado, clicável e FORA da janela: o gesto que resolve o atendimento
existia e ninguém o via. O defeito era intermitente: pela leitura do código,
dependia da ordem de chegada das duas consultas do fio. Quando as passagens
resolviam antes das mensagens, o esqueleto de carregamento ainda estava na tela,
o fio de verdade ainda não existia, e a rotina de ancoragem marcava a abertura
como concluída sobre um destino inexistente. Quando as mensagens chegavam, a
rotina acreditava que alguém estava lendo o histórico e devolvia sem rolar.
Agora a abertura só se encerra com o fio de verdade montado, então a conversa
passa a ancorar no fim, junto do convite, também quando o cartão chega antes
das mensagens.
Nada precisa ser feito ao atualizar. Contribuição de @webtecnica (#2664, issue #2515).
