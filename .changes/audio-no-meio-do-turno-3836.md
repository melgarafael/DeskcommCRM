---
impacto: nada_mudou
secao: corrigido
titulo: O agente deixa de dizer que não conseguiu ouvir o áudio que chegou durante a resposta
---

Quando o cliente mandava um áudio logo depois de outra mensagem, o agente podia responder "recebi o seu áudio, mas não consegui ouvir o conteúdo" — e a transcrição do áudio ficar pronta dois segundos depois. O cliente ouvia que não tinha sido ouvido e precisava escrever tudo de novo.

A espera pela transcrição existia, mas valia só para a mídia que já estava na conversa quando a resposta começava a ser preparada. O áudio que chegava **durante** esse preparo entrava na conversa sem texto, e o agente respondia sobre ele como se não pudesse ouvi-lo.

Agora a resposta espera a transcrição também nesse caso: antes de montar o que vai ser dito ao agente, o sistema reconfere a conversa e espera a mídia que ainda está sendo transcrita, dentro do mesmo teto de tempo de antes. Se a transcrição não ficar pronta dentro desse teto — a derivação travou, por exemplo —, a resposta segue sem o texto, e o registro diz que a espera foi encerrada pelo teto, em vez de a demora aparecer como falha de leitura do áudio.

A consequência prática é que a primeira resposta pode demorar até esse teto a mais em conversas com áudio recém-chegado; passado o teto, nada muda. Você não precisa mudar nada.
