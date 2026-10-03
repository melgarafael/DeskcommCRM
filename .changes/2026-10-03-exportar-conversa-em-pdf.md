---
impacto: capacidade_nova
secao: adicionado
titulo: Atendente baixa o histórico de uma conversa em PDF
---

Existia só o export de LGPD — e aquele é devido ao titular: ele que pede, a lista engloba outras tabelas e o arquivo sai por e-mail. O operador que precisa guardar como prova o histórico de UMA conversa não tinha para onde ir. Agora `GET /api/v1/conversations/[id]/export?formato=pdf` devolve o fio de mensagens em ordem cronológica, com autor, horário e direção em cada linha, o cabeçalho datado e quem exportou, e a razão social da organização no rodapé — prova citável, não dump binário. O papel `agent` baixa; `viewer` continua lendo a conversa na Inbox, mas não leva o arquivo, que é o histórico inteiro num download portátil. Reaproveita o mesmo padrão de PDF de `lib/propostas` (mesma biblioteca, mesma marca da organização), lê pelo client da sessão (RLS + `fn_can_view_conversation`) e não muda uma linha do export de LGPD. Conversa maior que o limite de mensagens por arquivo sai com o corte declarado no cabeçalho. Nenhuma mudança de banco.

Contribuição de @webtecnica (refs #1982).
