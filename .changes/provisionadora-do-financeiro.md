---
impacto: capacidade_nova
secao: adicionado
titulo: O módulo financeiro/comanda ganha a provisionadora que a ADR-0002 pedia
---

Até aqui as cinco tabelas da comanda (`sales`, `sale_items`, `commission_rules`,
`commissions`, `loyalty_ledger`) entravam pelo `baseline.sql` como qualquer
tabela do núcleo — todo clone as recebia, inclusive quem nunca instala o módulo
financeiro. É a opção que a ADR-0002 mediu e recusou (D9): as cinco vazias, com
os seus índices, custam ~368 KB a cada instalação.

Agora elas nascem na instalação do módulo, por `public.fn_financeiro_provisionar()`
— a peça que o contrato já cobrava (`fn_modulo_instalar` recusa módulo sem
`fn_<modulo>_provisionar()` e a chama quando existe; `fn_reaplicar_modulos_instalados`
a reaplica a cada atualização). A função é `security definer`, sem parâmetro, com
EXECUTE só de `service_role`, e termina chamando `fn_proteger_modulo_provisionado()`
na mesma transação — a tabela nasce protegida. Quem não instala o módulo não
carrega mais as tabelas dele.

O preço do corte, declarado: `financial_entries` é do caixa e fica no baseline,
mas `sale_id` apontava para `sales` — a coluna passa a ser `uuid` sem FK onde o
módulo não está, e a constraint volta pela própria provisionadora onde ele está.
E as funções de negócio (`fn_proximo_numero_de_comanda`, `fn_finalizar_comanda`,
`fn_estornar_comanda`, `fn_relatorio_financeiro`, `fn_saldo_de_fidelidade`) foram
reescritas para compilar sem as tabelas (D7): `language sql` e `%rowtype` são
validados na criação e recusam com `relation does not exist`, então passaram a
`plpgsql` com `record` e guarda `to_regclass`. O relatório financeiro volta com o
caixa fechado e as seções da comanda vazias — no mesmo formato, sem `null` e sem
`"R$ 0,00 em comandas"` mentindo.

Contribuição de @webtecnica (#1907).