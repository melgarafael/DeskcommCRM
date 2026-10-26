---
impacto: nada_mudou
secao: corrigido
titulo: Tabela nova continua alcançável pela API depois de 30/10
---

A partir de 30/10/2026, na nuvem da Supabase, uma tabela criada no schema público
deixa de receber sozinha as permissões de leitura e escrita dos papéis que a API
usa; sem isso, o aplicativo receberia erro de permissão negada em toda tabela
criada depois da data. A instalação passa a declarar essas permissões por conta
própria, do mesmo jeito que a instalação de hoje já as recebe.

Nada muda nas tabelas que já existem, e o dono da instalação não precisa fazer
nada: a atualização do kit reaplica o mesmo bloco, e quem instala pela linha de
comando do Supabase recebe a regra pela cadeia de migrations. Quem hospeda o
próprio servidor continua exatamente como está.
