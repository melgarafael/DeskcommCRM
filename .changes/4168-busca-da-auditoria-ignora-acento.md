---
impacto: nada_mudou
secao: corrigido
titulo: A busca dos filtros da Auditoria acha a empresa digitada sem acento
---

No painel de Auditoria da plataforma, o filtro de empresas ignorava maiúsculas,
mas não acento: digitar `clinica` não achava "Clínica Aurora". Agora a busca
usa a mesma régua da busca do Inbox, e `clinica` acha "Clínica Aurora".

Issue #4168.
