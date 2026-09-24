---
impacto: nada_mudou
secao: corrigido
titulo: Migrations 0388/0389 renumeradas para 0401/0402 (evita colisão com a main)
---

A `main` do upstream ganhou as migrations `0390`–`0400` depois da base antiga deste branch, e o timestamp `20260923140000` da migration `0388` passou a colidir com a `0390` do upstream (o hook de contribuição bloqueia timestamp repetido). Para o rebase não quebrar o gate, as duas migrations do branch foram renumeradas para o fim da sequência — `0401_etapas_funil_padrao_em_espanhol` e `0402_custo_desconhecido_vira_null` — com a tríade mantida no mesmo commit (arquivo + apêndice/correção no `baseline.sql` + linha no `MANIFEST.md`). O conteúdo SQL não mudou; só o número, o timestamp e as referências. Não há ação para quem opera a VPS.
