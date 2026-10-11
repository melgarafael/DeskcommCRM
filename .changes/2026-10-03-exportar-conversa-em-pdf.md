---
impacto: capacidade_nova
secao: adicionado
titulo: O histórico de uma conversa pode ser baixado em PDF pela API
---

Existia só o export de LGPD — e aquele é devido ao titular: ele que pede, a lista engloba outras tabelas e o arquivo sai por e-mail. O operador que precisa guardar como prova o histórico de UMA conversa não tinha para onde ir. Agora `GET /api/v1/conversations/[id]/export?formato=pdf` devolve o fio de mensagens em ordem cronológica, com autor, horário e direção em cada linha, o cabeçalho datado e quem exportou, e a razão social da organização no rodapé. O papel `agent` baixa; `viewer` continua lendo a conversa na Inbox, mas não leva o arquivo. Lê pelo client da sessão (RLS + `fn_can_view_conversation`), registra `conversation.exported` na auditoria (quantas mensagens, nunca o texto) e não muda uma linha do export de LGPD. Cada arquivo leva até as 500 mensagens mais recentes; conversa maior sai com o corte declarado no cabeçalho. O teto vem da memória medida do render, que roda no mesmo processo do CRM. Há limite de 5 exportações por minuto por pessoa e 20 por organização. O botão na tela da conversa ainda não existe: por ora o download é por essa rota, com a sessão de quem está logado. Nenhuma mudança de banco.

Contribuição de @webtecnica (refs #1982).
