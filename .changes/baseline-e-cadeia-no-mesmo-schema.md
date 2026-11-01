---
impacto: nada_mudou
secao: adicionado
titulo: Instalação e atualização passam a ser conferidas contra a cadeia de migrations
---

O esquema do produto vive em dois artefatos: os arquivos de `supabase/migrations/` (o caminho de quem usa o Supabase CLI) e o `supabase/baseline.sql`, que é o único que o instalador do self-host aplica. Nenhum teste aplicava os dois e comparava o resultado, então uma mudança que chegasse só na migration deixava a instalação com um banco diferente do que o repositório diz entregar — em silêncio, com a suíte inteira verde.

A conferência nova monta dois bancos no Postgres do harness: um com o baseline aplicado, outro com o baseline mais a cadeia inteira em ordem. Compara objeto por objeto — coluna, constraint, índice, policy, função, gatilho, tipo e permissão — e, quando algo diverge, diz o nome do objeto e a migration que o declara, nunca um "esquema diferente" genérico.

A primeira vez que ela rodou apontou cinco índices das métricas de atrito que existiam só na cadeia: quem instalava do zero ficava com o painel de atrito varrendo cinco tabelas quentes. Apontou também três divergências de permissão, entre elas duas funções que o caminho da cadeia fecha e a instalação deixava executáveis por qualquer papel. Os três blocos entraram no baseline, na mesma forma que as migrations declaram. Quem atualiza só precisa rodar a atualização de sempre.
