---
impacto: nada_mudou
secao: corrigido
titulo: Evento de duração zero no Google não trava mais a leitura da agenda
---

Quando alguém criava no Google Agenda um evento de terceiro com início igual ao fim, a sincronização da agenda falhava a página inteira e recomeçava do mesmo ponto na rodada seguinte: a tela mostrava «A leitura não terminou» para sempre, sem dizer qual evento era. Um único evento assim parava a agenda daquela conexão.

Agora o evento de duração zero é descartado da leitura — ele não ocupa horário e não deve bloquear o resto da página. Os demais eventos da mesma página entram normalmente.

Quando o problema é outro e algum evento realmente não pode ser lido, a mensagem passa a dizer o dia e a hora dele, para a pessoa corrigir ou remover esse evento no Google. A mensagem não traz o título nem o nome de quem participa, porque ela aparece na tela. O log técnico passa a registrar a classe do erro, o código e o nome da restrição do banco, também sem o texto livre do provedor.

Nada muda para quem não tem evento de duração zero: a leitura segue igual.
