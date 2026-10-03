---
impacto: nada_mudou
secao: corrigido
titulo: Teto de escrita por token passa a valer também no upload de mídia e na abertura de conversa pelo contato
---

Duas rotas que aceitam autenticação por token de servidor (Bearer `dsk_`) não
tinham o teto de escrita: o upload de mídia (`conversations/[id]/media`) e a
abertura de conversa pelo contato compartilhado (`open-with-contact`). O proxy
não decide sobre elas, então o que uma integração em laço fazia por ali não era
contado em lugar nenhum. As duas passam a chamar o mesmo `tetoDeEscritaDoToken`
que as irmãs (`messages`, `drafts`, `leads` e a agenda) já usavam.

Para quem integra, o efeito é o mesmo que já existe nas outras rotas: por
token, cada rota respeita o teto por token e por organização da janela em
vigor e recusa com 429 quando a cota esgota. Quem usa a sessão do navegador
não tem teto e não percebe diferença.

Outras duas rotas, `drafts/consume` e o anexo de nota interna, recebem o mesmo
teto como defesa em profundidade. Hoje elas não aceitam token sem sessão, então
para elas nada muda. Não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2012).
