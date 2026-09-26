---
impacto: capacidade_nova
secao: adicionado
titulo: O rascunho sugerido por integração passa a ser apagado 30 dias depois de vencer
---

O rascunho que outro sistema cria na conversa, o texto sugerido para revisar antes de enviar, guarda uma mensagem escrita para uma pessoa. Depois de vencido ele não abre nem pode ser usado, mas ficava guardado para sempre. Agora a limpeza diária (`data-retention`) apaga o rascunho 30 dias depois do vencimento (mínimo de 7), usado ou não. O que foi enviado continua na conversa, e a criação e o uso continuam na auditoria. Nada a fazer na VPS; o prazo muda com `DRAFT_RETENTION_DAYS` no `.env`. Contribuição de @webtecnica (#1719).
