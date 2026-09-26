---
impacto: capacidade_nova
secao: adicionado
titulo: Cadências de e-mail — construtor visual e inscrição de leads
---

Em **`/app/cadencias`**, quem administra monta uma sequência de e-mail por segmento: nome, tag de segmento, janela de envio, e os passos num construtor visual (e-mail, espera em dias úteis, ramificação por abriu/clicou/respondeu, WhatsApp e tarefa). A cadência nasce como rascunho, só ativa com pelo menos um e-mail válido, e pausar é obrigatório para editar o que já está no ar.

Quem vende inscreve um lead numa cadência ativa (`POST /api/v1/cadencias/:id/inscricoes`) — exige lead com contato e e-mail nesta organização, e recusa duplicidade.

**O que ainda não existe nesta versão**: o worker que lê as inscrições vencidas e efetivamente envia o e-mail. A cadência e a inscrição já ficam salvas no banco (`email_cadences`, `email_cadence_enrollments`, `email_cadence_events`, migration 0428), mas nenhum e-mail sai ainda — a fila só espera. Também não existe "caixa de e-mail por vendedor": o envio, quando existir, vai usar o transporte único da instalação (SMTP/Resend).

Não há ação para quem opera a VPS: a migration é aditiva e o apêndice do `baseline.sql` já cobre instalação nova e atualização.
