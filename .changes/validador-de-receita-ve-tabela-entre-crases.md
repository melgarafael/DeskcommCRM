---
impacto: nada_mudou
secao: corrigido
titulo: A segunda trava das receitas prontas confere de novo as tabelas
---

As receitas prontas do banco externo passam por duas travas antes de ler o banco do cliente: as tabelas liberadas na conexão e um conferente que só aceita leitura das tabelas da própria receita. O conferente não reconhecia nome de tabela escrito entre crases — a forma que toda receita usa — e por isso deixava de conferir as tabelas. Agora ele as reconhece em qualquer ponto da consulta, inclusive em subconsulta. A primeira trava funcionava e continua igual; nada muda para quem usa.
