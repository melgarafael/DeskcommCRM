# Spec 23 — Banco externo genérico: MySQL (fase 1)

Status: **PROPOSTA**. Base CONFIRMADA na Spec 20 e no código citado; o resto é decisão proposta, não comportamento existente.

Linhas citadas medidas em 07/10/2026 no commit `17a67d3da` (remedidas na `main`, que já contém o filtro por cliente #2280). A parte do rastro do agente (Segurança, item 4, e "Quais tabelas do CRM a leitura toca") foi medida em `1b193c85c`; a `main` seguinte (`548d70cd`) entrou com a retenção das tabelas da IA (migration 0587), que não toca `ai_agent_runs`.

## Objetivo

O conector `banco_externo` (Spec 20) hoje só fala PostgreSQL. Nem todo sistema do dono é
PostgreSQL: WordPress, ERPs pequenos e muita aplicação feita direto com IA rodam
**MySQL**. Esta spec expande o conector para **MySQL genérico** seguindo o desenho
que já existe — sem criar um "conector WordPress" com `if` por provider no núcleo.

WordPress funciona por consequência (MySQL genérico + receita de VIEW que achata o EAV),
não por código específico. WP-REST com senha de aplicação é outra família (HTTP, não SQL)
e fica para depois, como provider separado.

## Não medido (medir antes de implementar)

Nada abaixo é afirmação. Cada item vira um caso de integração (ver "Testes e prova"):

| # | O que não se sabe | Teste que mede |
|---|---|---|
| C1a | Se `START TRANSACTION READ ONLY` recusa escrita numa tabela **MyISAM**. **NÃO MEDIDO**. | Integração contra MySQL 8 com uma tabela MyISAM: tenta `INSERT` dentro de `START TRANSACTION READ ONLY` e registra se recusou ou gravou. |
| C1b | Se o driver `mysql2`, falando com um servidor hostil que peça `LOAD DATA LOCAL INFILE`, entrega arquivo da máquina do cliente. Defesa **PROPOSTA**: tirar a flag com `flags: ["-LOCAL_FILES"]` — **NÃO MEDIDO** se o driver aceita essa forma. | Integração contra servidor MySQL hostil (ou dublê de protocolo) que pede `LOAD DATA LOCAL`; confirma que nada é enviado com e sem a flag. |
| C1c | O que o `mysql2` faz com `ssl` desligado e com `verify-ca`. **NÃO MEDIDO**. **PROPOSTA**: no modo `disable`, simplesmente **omitir** a opção `ssl` em vez de passar `false`. | Integração contra MySQL sem TLS (modo `disable`, opção omitida) e contra MySQL com CA autoassinada (modo `verify-ca`), registrando conecta/recusa em cada combinação. |
| C1d | Se `MAX_EXECUTION_TIME` também interrompe a **espera por trava de metadados** (não só a execução). **NÃO MEDIDO** — INFERIDO (documentação do MySQL, não medido) que talvez não interrompa. | Integração com um `ALTER TABLE` pendurado numa segunda sessão (trava de metadados presa) enquanto o `SELECT` com a dica roda; registra se o `SELECT` morre no tempo ou espera junto. |
| C1e | Se o `standalone` do app leva o `mysql2` completo. **NÃO MEDIDO** — INFERIDO (comportamento do rastreamento, não medido). | Build do app (`pnpm build`) + `node server.js` abrindo uma conexão MySQL de teste; registra `MODULE_NOT_FOUND` ou sucesso. Licença e versão do `mysql2` também NÃO MEDIDAS (não está instalado) e se conferem ao adicionar. |
| C1f | Quanto custa a consulta de catálogo num banco de WordPress de verdade (milhares de colunas por plugins). **NÃO MEDIDO** — INFERIDO que pode ser lenta (ver "Desempenho do catálogo"). | Integração contra cópia de um WP real: tempo de `listarTabelas` no PG-equivalente e no MySQL, com e sem filtro de tabela. |
| C1g | Se o catálogo do MySQL de verdade respeita os privilégios do usuário. **NÃO MEDIDO** — INFERIDO. | Integração com usuário só-`SELECT`-em-uma-view: `listarTabelas` devolve só ela ou o banco inteiro; registra o observado. |

Tudo marcado **INFERIDO** nesta spec vira CONFIRMADO ou é corrigido pelo mesmo teste de
integração; nada disso entra em código antes disso.

## Decisões

| # | Tema | Decisão |
|---|---|---|
| D1 | Escopo da fase 1 | Só `mysql` via `mysql2/promise` (JS puro, sem binding nativo — INFERIDO, documentação, não medido — não quebra a lei de packaging). MariaDB **NÃO** é alias sem custo: ela usa `max_statement_time` (**em segundos**) e não conhece `MAX_EXECUTION_TIME` — INFERIDO (documentação, não medido). MariaDB continua fora da fase 1; a entrada dela exige essa adaptação. |
| D2 | O que continua e o que muda | Cadastro por organização, senha AES-GCM (`AI_CRED_AES_KEY`), guarda de host, tetos por conexão (`lib/external-db/limites.ts`), auditoria sem PII/valores de filtro, RLS (select = membro; escrita = `admin`). Contrato aditivo e compatível; a única mudança de comportamento é a de conexões CRIADAS depois (nascem com a lista vazia — ver "Fontes liberadas"). O que **muda**: a view `_safe` (ganha `db_type`, `last_test_aviso`, `source_mode`, `sources_count`), o `Acesso` (devolve dialeto em vez de `pg.Pool`, desde a Fatia 2a), as chamadas internas das rotas e tools, e o metadata do `audit()` de criação (ganha `db_type` + `source_mode`). |
| D3 | Colunas novas | Quatro colunas em `external_db_connections`, em **duas migrations**: Fatia 2a (`source_mode text not null default 'all'` com `CHECK (source_mode in ('all','list'))`, `sources jsonb not null default '[]'` com `CHECK (jsonb_typeof(sources) = 'array')` + teto de tamanho) e Fatia 4a (`db_type text not null default 'postgres'` com `CHECK (db_type in ('postgres','mysql'))`, `last_test_aviso text` anulável, o aviso de privilégio da D5). Postgres existente não sente nada (defaults cobrem). `sources_count` NÃO é coluna da tabela: é a expressão `jsonb_array_length(sources)` na view `_safe`; as quatro colunas da tabela são as listadas. |
| D4 | Núcleo | Interface **`Dialeto`** atrás do mesmo contrato: `consultar`, `listarTabelas`, `descreverTabela`, `colunasDaTabela`, `lerTabela`, `testar`, `fechar`. A interface nasce na Fatia 2a com os métodos de leitura (`listarTabelas`, `colunasDaTabela`, `lerTabela`) e `catalogoCompleto` (só para a tela de marcação, administrador), ligada à conexão (pool + regra de fontes), e cresce na Fatia 3 (`consultar`, `testar`, `fechar` e a escolha pelo `db_type`). O `Acesso` de `lib/external-db/acesso.ts` passa a devolver o **dialeto** no lugar de `pool: pg.Pool` (`acesso.ts:26-28`, CONFIRMADO que hoje devolve o pool) — isso já vale na Fatia 2a. O contrato HTTP e o das tools MCP é **aditivo e compatível: nada que existe muda de forma** (o que se soma está em "API"); **as chamadas internas mudam** (lista em "Núcleo" abaixo). |
| D5 | Somente leitura no MySQL | Quatro camadas: (1) `START TRANSACTION READ ONLY`; (2) só gerar `SELECT` em `montarConsulta()`; (3) operar com usuário MySQL `GRANT SELECT` apenas; (4) **PROPOSTA — decisão do mantenedor**: ao testar a conexão, rodar `SHOW GRANTS` e, se o usuário tiver mais que `SELECT`, gravar um aviso legível na coluna nova `last_test_aviso` (exposta na view e mostrada na tela como aviso amarelo, separado do erro) — por exemplo "este usuário pode escrever; crie um usuário só de leitura". Motivo: quem cola a senha do `wp-config` de um WordPress está colando um usuário com todos os poderes. A garantia final para MyISAM é **NÃO MEDIDO (C1a)**. Regras de leitura do `SHOW GRANTS` (NÃO MEDIDO, a medir na integração): o usuário é considerado escritor se QUALQUER linha trouxer `ALL PRIVILEGES` ou um destes privilégios fora de `SELECT`/`USAGE`: INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, TRUNCATE, GRANT OPTION, FILE, SUPER, PROCESS, EXECUTE, CREATE ROUTINE, ALTER ROUTINE, TRIGGER, EVENT, LOCK TABLES; `GRANT USAGE` sozinho não é aviso; linha de role (`GRANT role TO user`) é NÃO MEDIDO — havendo role, o teste grava "não consegui conferir os papéis; confirme que o usuário só lê". Quem falhar ao rodar `SHOW GRANTS` (sem permissão) não derruba o teste de conexão: grava "não consegui conferir os privilégios". Leitura ampla demais (ver "O que o agente consegue ver") também é aviso: `SELECT` em `*.*` ou em `banco.*` grava "este usuário lê o banco inteiro; libere só as views que o agente deve ver". Isso é uma ajuda, não a garantia (a garantia continuam as camadas 1 a 3). |
| D6 | WordPress | Sem código WP no núcleo. Receita em docs: expor `view_imoveis_disponiveis` achatada; o agente lê a view. |
| D7 | Fontes liberadas | **DECIDIDA nesta proposta**: o MySQL só sai com a lista — o administrador marca, por conexão, quais tabelas/views (e quais colunas) o assistente e a grade podem ler. Entra primeiro nas fatias 2a/2b, só com PostgreSQL; o MySQL (4a/4b) vem depois e já nasce com ela. Resolve custo (a lista inteira deixava de voltar ao modelo) e exposição (`wp_users` fora da vista). Consulta salva e cópia em cache ficam de fora (ver "Fora de escopo"). Detalhe em "Fontes liberadas". |

## Superfície

### Schema (tripla, Lei em `CLAUDE.md`)

- **Duas migrations** (nunca editar a `0372`): (a) Fatia 2a — `add column source_mode`,
  `add column sources`, CHECKs de vocabulário do `source_mode`, forma do array e teto de
  tamanho; (b) Fatia 4a — `add column db_type`, `add column last_test_aviso`, CHECK de
  vocabulário do `db_type`. Cada uma com cabeçalho `-- manifest: <o quê e por quê>`.
  Sem número escrito na spec: usar `pnpm checar:colisao-de-migration` (`package.json:33`,
  CONFIRMADO). `MANIFEST.md` é histórico — **não** recebe linha nova.
- Apêndice **idempotente** por migration em `supabase/baseline.sql`, **DEPOIS da última redefinição da
  view** (hoje em `baseline.sql:47870-47882`, CONFIRMADO na `main`: `drop view` + `create view` +
  `revoke all ... from anon` + `grant select ... to authenticated`). Cada apêndice recria a
  view com as suas colunas no **FIM** da lista de colunas (Fatia 2a: `source_mode` e
  `sources_count`; Fatia 4a: `db_type` e `last_test_aviso`) e **reemite** o `revoke` e o
  `grant`. A view recriada parte DESSA definição de 20 colunas (com `customer_key_*` do
  #2280) — perdê-las apagaria o filtro por cliente da tela. Todas as regras de forma (tripla com apêndice, `-- manifest:`, `revoke`/`grant`
  reemitidos, colunas novas no FIM) valem para as duas.
- RLS inalterada (select = membro; escrita = `admin`).
- Dados existentes: sem backfill além dos defaults (`postgres`, `null`, `all`, `'[]'`).
- ADR-0002: coluna nova em tabela que **já está no baseline desde a 0372** não cria tabela
  de módulo — segue a tripla normal; a ADR-0002 trata de tabelas **novas** de módulo
  (função provisionadora), então não se aplica aqui.

Onde a lista de colunas está copiada à mão (a view hoje tem 20 colunas — `id`,
`organization_id`, `label`, `host`, `port`, `database_name`, `username`, `ssl_mode`,
`enabled`, `max_rows`, `max_filters`, `max_response_bytes`, `customer_key_column`,
`customer_key_kind`, `last_tested_at`, `last_test_ok`, `last_test_error`, `created_by`,
`created_at`, `updated_at` — CONFIRMADO na migration 0558 e no `baseline.sql`; cada lista
abaixo ganha `db_type`, `last_test_aviso`, `source_mode` e `sources_count`):

| Arquivo | Lista |
|---|---|
| `app/api/v1/external-db/connections/route.ts:36-37` | `COLUNAS_SEGURAS` (as 20 colunas; lista + `.select` + retorno do insert) |
| `app/api/v1/external-db/connections/[id]/route.ts:34-35` | `COLUNAS_SEGURAS` (as 20 colunas; GET + retorno do PATCH) |
| `app/app/integracao-dados/page.tsx:25-26` | `COLUNAS_SEGURAS` da lista (as 20 colunas) |
| `app/app/integracao-dados/[id]/page.tsx:31` | `.select("id, label, host, port, database_name, username, ssl_mode, enabled")` (só 8 — o detalhe não carrega o resto) |
| `hooks/external-db/useConexoesExternas.ts:10-31,59-73` | `ConexaoExternaRow` e `EntradaDeConexao` (tipos que espelham as colunas, já com `customer_key_*`) |
| `lib/mcp/tools/dados-externos.ts:101-106` | **Precisa (campo `motor`)**: o `.select("id, label")` passa a incluir `db_type`, para o `motor` acompanhar o objeto `conexao` das duas tools e cada item da lista de `conexao_ambigua` |

O `audit()` de `external_db_connection.created` (`connections/route.ts:143-151`,
CONFIRMADO metadata `{label, host, port, ssl_mode}`) passa a gravar `db_type` e `source_mode` no metadata.

### Núcleo `lib/external-db/`

| Arquivo | Mudança |
|---|---|
| `types.ts` | `TipoBanco = "postgres" \| "mysql"` (símbolo novo); campo `dbType` em `ConexaoExterna`. `ModoTls` inalterado. |
| `lib/external-db/dialetos/mysql/conexao.ts` (novo) | Pool `mysql2/promise` por conexão; `testarConexao` com `SELECT 1` descartável; `SHOW GRANTS` do aviso de privilégio (D5). Pasta própria para não confundir com `conexao.ts`. |
| `lib/external-db/dialetos/mysql/introspeccao.ts` (novo) | Mesmo contrato `TabelaExterna`; ver seção de introspecção. |
| `lib/external-db/dialetos/mysql/leitura.ts` (novo) | `montarConsulta()` do dialeto: crase, `?`, `ESCAPE '!'`; expressão completa em "`contem` / `comeca_com` no MySQL". |
| `conexao.ts` | Vira **fachada**: escolhe o dialeto pelo `dbType`. Chave do pool: hoje `chaveDaConexao` = id, versão (`updated_at`), host, porta, banco, usuário e modo TLS (`conexao.ts:35-37`, CONFIRMADO) — a fase 1 só **ACRESCENTA** `dbType`. `fecharPool(id)` e `fecharTodosOsPools()` passam a derrubar o pool do dialeto da conexão (e todos os dialetos, no plural). Chamadores de `fecharTodosOsPools` hoje: só `lib/external-db/conexao.test.ts:3,27` (CONFIRMADO por `grep` em lib/app/workers/tests/hooks na `main` `17a67d3da`) — nenhum chamador de produto muda. |
| `introspeccao.ts` / `leitura.ts` | Viram fachada pelo `dbType`. Os testes PostgreSQL atuais (`leitura.test.ts`, `introspeccao.test.ts`, `conexao.test.ts`, `credenciais.test.ts`, `guardas.test.ts`, `schemas.test.ts`) continuam como estão. |
| `acesso.ts` | Devolve `{ ok: true; conexao; dialeto }` em vez de `{ ...; pool: pg.Pool }` (já na Fatia 2a). Revalidação de host e gate do módulo inalterados. |
| `schemas.ts` | `db_type` entra **SÓ na criação** (`criarConexaoSchema`); porta padrão depende do motor (`3306`/`5432`) e isso exige transformação **depois do `parse`**, porque `.default(5432)` hoje é fixo (`schemas.ts:70`) e os schemas são `.strict()` (`schemas.ts:82,105`, CONFIRMADO). `customer_key_column` + `customer_key_kind` (coluna + `phone`|`email`, os dois juntos ou nenhum — `schemas.ts:46-47,51-63,79-80`, CONFIRMADO) entram nos dois schemas sem mudar essa regra. **PROPOSTA — decisão do mantenedor**: `db_type` é imutável depois de criado (`atualizarConexaoSchema` não o aceita; trocar de motor = apagar e criar), e na tela o seletor de motor fica desabilitado ao editar. |
| `credenciais.ts` | Lê e devolve `db_type`. Cifra inalterada. |

Arquivos que chamam hoje com `pg.Pool` e mudam de chamada interna (CONFIRMADO abrindo cada um):

| Arquivo | Uso hoje |
|---|---|
| `app/api/v1/external-db/connections/[id]/schemas/route.ts:18,49` | `listarTabelas(acesso.pool)` |
| `app/api/v1/external-db/connections/[id]/tables/[schema]/[tabela]/route.ts:19-20,70,92` | `colunasDaTabela(acesso.pool, ...)` e `lerTabela(acesso.pool, ...)` |
| `app/api/v1/external-db/connections/[id]/test/route.ts:20,58` | `testarConexao(leitura.conexao)` (recebe a conexão, não o pool — muda pela fiação do dialeto; grava `last_tested_*`, `last_test_error` e `last_test_aviso` conforme o retorno do `testar`) |
| `app/api/v1/external-db/connections/[id]/route.ts:22,153,200` | `fecharPool(id)` no PATCH (quando muda credencial/destino) e no DELETE |
| `lib/mcp/tools/dados-externos.ts` | `abrirAcesso()` + `listarTabelas` / `colunasDaTabela` / `lerTabela` com `acesso.pool` (descrever: `abrirAcesso` ~linha 231, `listarTabelas` ~linha 236; consultar: `abrirAcesso` ~linha 342, `listarTabelas` ~linha 428, `colunasDaTabela` ~linhas 419/441, `lerTabela` ~linha 483) |
| `lib/mcp/tools/dados-externos.test.ts:3-11,71` | Simula `acesso`, `introspeccao` e `leitura` (`pool: {} as never`) |
| `tests/unit/valor-de-filtro-nao-vai-ao-audit.test.ts:26-39` | Simula os mesmos três módulos |
| `lib/instalacao/modulos.test.ts:13,116-127` | Simula o gate do módulo via `abrirAcesso()` com o módulo desligado |

Mapeamento TLS MySQL (**PROPOSTA**, a confirmar em C1c): `disable→opção `ssl` omitida`,
`prefer/require→{rejectUnauthorized:false}`, `verify-ca/verify-full→{rejectUnauthorized:true}`.
Default continua `require`; `disable` só para rede local confiável.

Retorno do `testar`: hoje `ResultadoDeTeste = { ok: true } | { ok: false; erro: string }`
(`conexao.ts:149`, CONFIRMADO). Novo tipo: `{ ok: true; aviso?: string } | { ok: false; erro: string }`;
o dialeto PostgreSQL nunca devolve `aviso`. A rota `/test` grava `last_test_aviso = aviso ?? null`
(sucesso sem aviso limpa o aviso antigo) e `last_test_error = null` no sucesso; na FALHA grava
`last_test_aviso = null` (sem conexão não há o que avisar).

### API `/api/v1/external-db/` (contrato aditivo e compatível)

Mesmas rotas da Spec 20. O que se soma, sem quebrar nada que existe:

- `POST /connections`: corpo ganha `db_type` (opcional; padrão `postgres`).
- Respostas de lista, detalhe, criação e edição ganham `db_type` e `last_test_aviso` (e, pela Fatia 2a, `source_mode` e `sources_count`).
- `POST /connections/:id/test` ganha `aviso` (texto opcional) na resposta — hoje devolve
  `{ok:true, testado_em}` ou `{ok:false, erro, testado_em}` (`test/route.ts:81-83`, CONFIRMADO);
  passa a devolver `{ok:true, testado_em, aviso?}` ou `{ok:false, erro, testado_em}`.
- `PATCH` continua sem aceitar `db_type` (motor imutável).

Mudanças internas: Zod valida `db_type`; `POST/PATCH` validam o host antes de gravar (igual);
`POST [id]/test` testa no dialeto da conexão e grava `last_tested_*`, `last_test_error` e
`last_test_aviso` (erro truncado, sem segredo); `ok()`/`fail()`; `requireRole` (`admin` p/
escrita); `audit()` em mutação **e** leitura (metadata sem PII, valores de filtro redigidos;
criação ganha `db_type` + `source_mode`).

### Tela `/app/integracao-dados`

- `FormularioDeConexao`: `Select` de motor (PostgreSQL / MySQL); porta sugere `5432`/`3306`
  ao trocar o motor; resto idêntico (senha nunca exibida, limites, TLS, ativa/inativa).
- Textos neutros quanto ao motor: `page.tsx:51` diz hoje "uma planilha em PostgreSQL" e
  `ListaDeConexoes.tsx:111-113` diz "quando o seu outro sistema escreve num PostgreSQL"
  (CONFIRMADO) — passam a "um banco PostgreSQL ou MySQL". Entradas novas no dicionário
  (`lib/i18n/dicionario.ts`; idiomas: pt na chave, `es`, `en`, `zh-CN` — CONFIRMADO
  `dicionario.ts` com `es:` e `lib/i18n/traducoes/{en,zh-CN}.json`).
- O aviso amarelo do `last_test_aviso` fica ao lado da mensagem de teste de hoje: o cartão
  mostra `last_test_error` em `ListaDeConexoes.tsx:158-160` (CONFIRMADO) e o botão `Testar`
  em `ListaDeConexoes.tsx:174-181`; o formulário sugere "Use Testar para conferir o acesso"
  (`FormularioDeConexao.tsx:205`, CONFIRMADO).
- O #2280 já mexeu nesses dois arquivos (campo "Cliente nas conversas" no formulário,
  `FormularioDeConexao.tsx:46-50,116-119,160-163,332-375`, e aviso de coluna ausente na lista,
  `ListaDeConexoes.tsx:161-167`) — as fatias 2b e 4b partem desse desenho (ver "O filtro por
  cliente (#2280) e as fontes liberadas são travas complementares").
- Prova visual exigida (Definition of Done do `CLAUDE.md`, item 12): criar → testar →
  explorar → grade, nos dois motores.

### Tools do agente (contrato aditivo e compatível: o formato não muda)

`crm_describe_external_data` / `crm_query_external_data` ganham o campo `motor`, ficam presas
às fontes liberadas (`describe` só lista as liberadas, com descrição, com teto de bytes) e
passam a devolver `fonte_nao_liberada` e `sem_fontes_liberadas`; o formato dos campos que já
existem não muda.
Sem `connection_id`, regra atual (única ativa vence; várias pedem escolha). Aviso fixo de
dado-não-confiável, `redigirParaAuditoria`, `motivoDoVazio` e "filtro sem resultado devolve
vazio" (Spec 20) valem para os dois motores.

### Tempo limite e travas (PostgreSQL × MySQL)

O PG aplica, **dentro da transação**, `set local statement_timeout`, `set local lock_timeout`
e `set local idle_in_transaction_session_timeout` (`conexao.ts:134-137`, CONFIRMADO).

| Trava PG | Equivalente MySQL (PROPOSTA) | Motivo |
|---|---|---|
| `statement_timeout` (10 s) | `MAX_EXECUTION_TIME(10000)` — INFERIDO (documentação, não medido): só vale para `SELECT`, MySQL 5.7.8+. Aplicar **a cada vez que a conexão é emprestada do pool** (ou como dica `/*+ MAX_EXECUTION_TIME(10000) */` no `SELECT`), **NUNCA só na criação do pool**: `SET SESSION` fica preso na conexão reutilizada, ao contrário do `SET LOCAL`. | Evita que um `SELECT` pesado prenda o worker. |
| `lock_timeout` | `SET SESSION lock_wait_timeout = 5` a cada empréstimo, junto com o tempo máximo de execução — INFERIDO (documentação do MySQL, não medido). Cobre a espera por **trava de metadados** (por exemplo enquanto um `ALTER TABLE` roda no banco do cliente — o WordPress faz isso ao atualizar plugin; o padrão do servidor é muito longo). Se C1d medir que `MAX_EXECUTION_TIME` já interrompe essa espera, esta linha cai. | Sem ela, um `ALTER` no banco de origem pendura a leitura até o padrão do servidor. |
| `idle_in_transaction_session_timeout` | Sem equivalente direto — INFERIDO (documentação, não medido). Aceitar: leitura consistente do InnoDB (MVCC) não trava esperando lock de escrita. | Paridade aproximada sem custo. |
| MyISAM (qualquer trava) | **NÃO MEDIDO (C1a e C1d)**: MyISAM trava a tabela na leitura; o efeito real das travas nela só existe depois do teste. | Não prometer o que não se mediu. |

### Introspecção MySQL (`lib/external-db/dialetos/mysql/introspeccao.ts`)

Decisões (conferido o SQL do PG em `lib/external-db/introspeccao.ts:35-64`; o lado MySQL é
INFERIDO — documentação, não medido):

- A listagem fica presa ao banco da conexão: `table_schema = <database_name da conexão>`
  (**parâmetro**, nunca concatenação). O MySQL **nunca** lista `information_schema`, `mysql`,
  `performance_schema`, `sys` — sem isso o agente enxerga o catálogo do servidor.
- `schema` da API = nome do banco; pedido com outro schema é recusado (`tabela_nao_encontrada`).
- `SCHEMA` é palavra reservada no MySQL: o alias sai com crase (``as `schema` ``).
- Colunas com alias em **minúscula** (o MySQL 8 devolveria MAIÚSCULA sem alias, e o `agrupar()`
  do PG casa por nome exato); `coalesce(table_rows, 0)` porque view vem `NULL`;
  chave primária por `statistics` com `index_name = 'PRIMARY'` ordenada por `seq_in_index`.
- Observação: `lib/mcp/tools/dados-externos.ts:438` prefere o schema `public` e, sem ele,
  pega a primeira candidata (`candidatas[0]`). No MySQL só existe um schema, então isso
  funciona sem adaptação.

### `contem` / `comeca_com` no MySQL

O PG faz (CONFIRMADO em `lib/external-db/leitura.ts:81-86`):

```sql
replace(lower(cast("col" as text)), ' ', '') like $1 escape '\'
```

O dialeto MySQL faz (INFERIDO — documentação, não medido):

```sql
replace(lower(cast(`col` as char)), ' ', '') like ? escape '!'
```

Trocas em relação ao PG: `cast(col as text)` vira `cast(col as char)` (o MySQL não tem
`text` como alvo de `cast` e não tem `ILIKE` — INFERIDO, documentação, não medido); aspas duplas viram crase; `$n` vira `?`;
`escape '\'` vira `escape '!'`. Motivo da troca do escape: a barra muda de significado
conforme o `sql_mode` (`NO_BACKSLASH_ESCAPES`), e o `'\'` vindo do JavaScript abre uma
aspa que nunca fecha no MySQL — então ela não serve como caractere de escape portável.
O valor é preparado com o mesmo tratamento de `escaparLike` do PostgreSQL
(`leitura.ts:37-39`, CONFIRMADO), trocando o caractere de escape para `!` (e escapando o
próprio `!`, além de `%` e `_`).

## Diferença conhecida entre motores

Verdade do código no PostgreSQL (CONFIRMADO em `leitura.ts:81-86,135-139`): `contem` e
`comeca_com` **JÁ** ignoram maiúscula e espaços nos dois lados; o resto (`eq`, `ne`, `in`,
`gt`, `gte`, `lt`, `lte`, `order by`) usa a collation do banco. O lado MySQL é INFERIDO
(documentação, não medido).

| Operador | PostgreSQL (CONFIRMADO) | MySQL (INFERIDO) |
|---|---|---|
| `contem`, `comeca_com` | Ignoram maiúscula e espaços; **distinguem acento** | Ignoram maiúscula, espaços e — pela collation `_ci`/`_ai_ci` usual — **acento** |
| `eq`, `ne`, `in` | Distinguem maiúscula e acento (collation do banco) | Seguem a collation da coluna (normalmente `_ci`: ignoram maiúscula; `_ai_ci` ignora acento também) |
| `gt`, `gte`, `lt`, `lte`, `order by` | Collation do banco | Collation da coluna |

**PROPOSTA — decisão do mantenedor**: documentar a diferença em vez de forçar paridade; o
teste de integração fixa o comportamento dos dois motores para ela não virar regressão
silenciosa.

## Driver `mysql2`: escolhas (PROPOSTA; fatos do driver INFERIDOS — documentação, não medido)

| Opção | Decisão proposta | Motivo |
|---|---|---|
| `execute` vs `query` | `execute` (preparado de verdade no servidor) em vez de `query` (que escapa no cliente) | Paridade com o `$n` do PG: valor nunca vira texto do SQL. Ressalva: `execute` não aceita `undefined` — converter para `null`; confirmar na integração. |
| Datas | `dateStrings: true` | Devolve texto, sem converter pelo fuso do processo. |
| Números grandes | `supportBigNumbers: true` e `bigNumberStrings: true` | Paridade com o `bigint→string` de `serializarValor()` (`leitura.ts:162`, CONFIRMADO). |
| `multipleStatements` | `false` | Sem segunda sentença por chamada, em nenhum dialeto. |
| Pool | `connectionLimit: 2`, `connectTimeout: 5000`, `idleTimeout: 30000` | Os mesmos valores de `conexao.ts:24-27` (CONFIRMADO: `MAX_CONEXOES_POR_POOL = 2`, `CONNECTION_TIMEOUT_MS = 5_000`, `IDLE_TIMEOUT_MS = 30_000`). |
| Binário (BLOB/BINARY) | Hex com prefixo `0x` | Formato definido por dialeto; o do PostgreSQL (`\x…`, `leitura.ts:164`, CONFIRMADO) continua como está. |
| `LOAD DATA LOCAL` | `flags: ["-LOCAL_FILES"]` — confirmar que o driver aceita essa forma (C1b, NÃO MEDIDO) | Servidor hostil não pode puxar arquivo da máquina do cliente. |

## Como o agente lê o banco externo (PostgreSQL hoje × MySQL)

### O fluxo de uma leitura

1. O modelo chama `crm_describe_external_data` (`crmDescribeExternalData`,
   `lib/mcp/tools/dados-externos.ts:215`, CONFIRMADO) ou `crm_query_external_data`
   (`crmQueryExternalData`, `dados-externos.ts:323`, CONFIRMADO).
2. `resolverConexao` (`dados-externos.ts:95-133`, CONFIRMADO) lê as conexões ATIVAS da
   organização em `external_db_connections_safe` (`.select("id, label")`,
   `.eq("organization_id", ctx.organizationId)`, `.eq("enabled", true)` —
   `dados-externos.ts:101-106`, CONFIRMADO; o `organization_id` vem do contexto do turno,
   nunca do modelo). Com uma só ativa, usa-a e ignora `connection_id` inventado (120);
   com várias, exige um id válido ou devolve `conexao_ambigua` com a lista (125-132); sem
   nenhuma, `sem_conexao` (109-119).
3. `abrirAcesso` (`lib/external-db/acesso.ts:30-56`, CONFIRMADO) confere o módulo ligado
   (39), carrega a conexão com filtro de organização e decifra a senha (via
   `carregarConexao`), revalida o host (44-53) e devolve o pool — na fase 1, o dialeto (D4, já na Fatia 2a).
4. Filtro do cliente (#2280 — só no `query`, só na conversa, CONFIRMADO em
   `dados-externos.ts:345-368`): com turno (`ctx.contatoDoTurno`) E coluna do cliente
   configurada (`acesso.conexao.chaveDoCliente`, 356-358), os identificadores do contato
   (telefone em 2 ou 3 formas — com `+`, sem `+`, e sem o 55 brasileiro quando houver — ou
   e-mail — `identificadoresDoContato`, 143-165) entram como
   filtro `in` somado com `and` aos do modelo (367); sem coluna configurada a consulta segue
   como antes, e fora do turno nada muda (352-354). Sem identificador no contato,
   `cliente_sem_identificador` (360-366); tabela sem a coluna,
   `tabela_sem_identificador_do_cliente` (454-461). Na fase 1, a lista de fontes vale antes
   dele (ver "O filtro por cliente (#2280) e as fontes liberadas são travas complementares").
5. `describe` chama `listarTabelas` (236): consulta AO VIVO ao catálogo do banco de origem,
   nada espelhado — devolve até 60 tabelas com até 60 campos cada (`MAX_TABELAS_DESCRITAS`,
   `MAX_COLUNAS_POR_TABELA` em `dados-externos.ts:46-47`, CONFIRMADO): nome, tipo, chave,
   linhas estimadas e campos (nome, tipo, obrigatório) (263-274, CONFIRMADO). `query`
   valida os filtros (filtro sem valor vira `filtro_sem_valor`, 385-398, CONFIRMADO), resolve
   schema/tabela pelo catálogo (410-445, CONFIRMADO), monta o `SELECT` com identificadores
   validados e valores como parâmetros, roda em transação só de leitura, aplica o teto de
   linhas (`maxRows`, 477/484, CONFIRMADO) e de bytes (`maxResponseBytes`, 510, CONFIRMADO) da
   conexão — na fase 1, pelo dialeto da conexão.
6. A chamada é auditada: `auditMcpToolCall` com ação `mcp.tool_called` e recurso `mcp_tool`
   (`lib/mcp/audit.ts:79,87-91`, CONFIRMADO); os valores de filtro saem do registro por
   `redigirParaAuditoria` (função `redigirConsulta` em `dados-externos.ts:311-321`, exposta
   como `redigirParaAuditoria` na tool em :336; aplicada no turno em
   `lib/ai/runtime/tools.ts:243-245`, CONFIRMADO).

| Ponto | PostgreSQL hoje (CONFIRMADO) | MySQL fase 1 |
|---|---|---|
| Catálogo consultado | `information_schema` + `pg_catalog` em todos os schemas, exceto `pg_catalog`, `information_schema`, `pg_toast` (`introspeccao.ts:35-64`) | `information_schema` preso ao banco da conexão (INFERIDO) |
| O que "schema" significa | schema do PostgreSQL | nome do banco |
| Nomes de tipo | `integer`, `text` | `int`, `varchar` (INFERIDO) |
| Estimativa de linhas | `pg_class.reltuples` (`introspeccao.ts:45`) | `table_rows`, aproximada (INFERIDO) |
| Transação só de leitura | `BEGIN READ ONLY` (`conexao.ts:134`) | `START TRANSACTION READ ONLY` (PROPOSTA) |
| Teto de tempo | `statement_timeout` 10 s (`conexao.ts:135`) | `MAX_EXECUTION_TIME` (PROPOSTA, C1d) |
| Operadores de filtro | Mesma lista (`operadorSchema`, `dados-externos.ts:49-61`) | Mesma lista |
| Limites por conexão | `max_rows`, `max_filters`, `max_response_bytes` | Os mesmos |
| Aviso fixo e audit | `AVISO_DADOS_NAO_CONFIAVEIS` + `mcp.tool_called` sem valores | Os mesmos |

### Como a informação é marcada para o modelo

O que acompanha o dado (CONFIRMADO em `dados-externos.ts:276-281,524-541`): no consultar,
`conexao: { id, label }`, `schema`, `tabela`, `colunas`, `linhas_devolvidas`, `limite_aplicado`,
`truncado`, `filtro_sem_resultado`; no descrever, `conexao`, `tabelas` (cada item com schema,
nome, tipo, chave, linhas estimadas e campos) e `truncado`; nas duas, o `aviso` fixo (`AVISO_DADOS_NAO_CONFIAVEIS`,
`dados-externos.ts:41-44`: dado, nunca instrução).

**PROPOSTA — decisão do mantenedor:** acrescentar o campo `motor` (`postgres` | `mysql`) ao
objeto `conexao` das duas tools e a cada item da lista de `conexao_ambigua`, porque o modelo
escolhe o que fazer em seguida (por exemplo repetir a busca com um trecho menor) e o MySQL
ignora acento e maiúscula onde o PostgreSQL não (ver "Diferença conhecida entre motores").
Por isso o `.select("id, label")` de `dados-externos.ts:101-106` passa a incluir `db_type` —
a linha correspondente na tabela de colunas copiadas à mão foi corrigida.

### Quais tabelas do CRM a leitura toca (e quais NÃO)

LÊ: `external_db_connections_safe` (`resolverConexao`, `dados-externos.ts:101-106`);
`external_db_connections` com cliente de serviço e filtro de organização (`carregarConexao`,
`lib/external-db/credenciais.ts:75-87`, CONFIRMADO); `platform_config` (chave
`MODULO_BANCO_EXTERNO` via `moduloLigado`, `lib/instalacao/modulos.ts:82,170`, CONFIRMADO).
ESCREVE: `api_audit_log` (ação `mcp.tool_called`, recurso `mcp_tool`) — e
`external_db_connections.last_test_*` só quando o admin aperta Testar (rota `/test`).

Cópia sincronizada não há: sem tabela de espelho, sem embeddings do banco externo —
leitura ao vivo a cada chamada; a fase 1 não cria tabela nenhuma; acrescenta quatro colunas
à `external_db_connections` (D3). **Mas** o resultado devolvido ao agente, no turno do
agente, fica gravado no rastro da execução (`ai_agent_runs.tool_calls`): `serializeSteps`
(`lib/ai/runtime/serialize.ts:53-66`, com `result: redactValue(result)` em :63,
CONFIRMADO POR LEITURA, não executado) grava o resultado de cada ferramenta; o `trace` é
montado em `lib/ai/runtime/agent.ts:710` e gravado em :737, :766, :795 e :838
(CONFIRMADO POR LEITURA, não executado). A redação é só pelo nome da chave (`REDACT_KEYS`
em `serialize.ts:8-14`: `authorization`, `api_key`, `token`, `password`, `cpf`) e corta
string longa em 500 + `...[truncated]` (:16-29) — linha com `email`, `telefone`, `endereço`,
`hash` passa inteira. No MCP externo (`/api/mcp`), o resultado NÃO vai para
`ai_agent_runs` (só `lib/mcp/audit.test.ts:46` menciona a tabela, num comentário;
CONFIRMADO POR LEITURA, não executado). Efeito da lista de fontes aqui: ela reduz o que
PODE ser lido e, portanto, o que pode ir parar no rastro; não apaga o que já foi lido nem
muda o rastro.
A leitura NÃO aparece na linha do tempo do contato — aparece no registro de auditoria, no
painel de capacidades e no rastro do agente. Decisão proposta: é leitura pura, como as tools de catálogo e
conhecimento, que o Testar lê sem contato (`preview.ts:147-159`).

### Os dois ingressos, as mesmas tools

(a) Turno do agente, em processo: `pickToolsFromMcp` (`lib/ai/runtime/tools.ts:512`,
CONFIRMADO) monta só as tools que a versão do agente tem marcadas (`toolIds`, 515),
descarta as de módulo desligado (`deModuloDesligado`, 536, CONFIRMADO) e as capacidades que
a organização desligou (540); a auditoria usa `redigirParaAuditoria` (243-245, CONFIRMADO).
(b) MCP externo `/api/mcp` (`lib/mcp/server.ts`): token `dsk_` (`lib/mcp/auth.ts:154`,
CONFIRMADO), escopo `mcp:read` (declarado em `auth.ts`, exigido em `server.ts:108`, CONFIRMADO), papel
mínimo `agent` (`server.ts:109`, CONFIRMADO; padrão `agent` em `lib/mcp/types.ts:58`), mesmo handler
(111), mesma auditoria (118-128) — e `summarizeResult` (`server.ts:29-37`, CONFIRMADO) só
resume `contacts`, `conversations`, `messages` ou `id`: o resultado de uma consulta externa
(`conexao`, `schema`, `tabela`, ...) NÃO vai para o registro de auditoria.

Outros arquivos que citam os NOMES das tools e NÃO mudam com o MySQL (os nomes não mudam):
`lib/agent-engine/agent/preview.ts:152-153` (entram no `SCENARIO_READS` do Testar — leitura
sem contato, como catálogo e conhecimento);
`lib/agent-engine/agent/tool-breaker.ts:60-70` (lista `READ_ONLY_TOOLS` — leitura pura);
`lib/atendimento/fronteira-server.ts:143-153` (conjunto de leitura do `guardServiceTools` —
sem fronteira porque o `SELECT` já corre em transação somente-leitura);
`lib/mcp/tools/catalogo/dados-externos.ts:28,38` (pacotes `["organizar"]` nas duas entradas —
"são capacidades de FONTE DE DADOS", 22-27). COMO o pacote "organizar" chega a um agente de
atendimento na tela é NÃO MEDIDO.

### O que o agente consegue ver: só as fontes liberadas

Com a lista da seção "Fontes liberadas", `listarTabelas` devolve só o marcado — e a leitura
é limitada ao cliente da conversa quando a conexão tem a coluna do cliente configurada
(#2280: `customer_key_column` + `customer_key_kind`; sem ela, não). O `contatoDoTurno` de
`lib/mcp/types.ts:23-41` escopa as tools do CRM (contatos, conversas, comércio); as externas
só o leem para esse filtro de cliente. Sem a lista
(modo `all`, inclusive todo PostgreSQL hoje) e sem a coluna do cliente, vale o que sempre
valeu: tudo que o usuário do banco enxerga — a conta do `wp-config` vê `wp_users` (hashes de
senha), `wp_usermeta`, `wp_options`, e um cliente no WhatsApp que induza o modelo (injeção de
instrução) pode levar essas linhas para a conversa. O aviso de privilégio do `SHOW GRANTS` (D5, `last_test_aviso`)
continua como segunda camada, agora para "o usuário do banco pode mais do que a lista
libera" (casos `SELECT` em `*.*` e em `banco.*` mantidos).

### Desempenho do catálogo

`listarTabelas` roda a consulta completa ao catálogo a cada chamada em que o schema não veio
ou veio errado (`dados-externos.ts:425-445`, CONFIRMADO), sem cache; no MySQL a consulta fica
presa a um banco, mas um WordPress com muitos plugins tem milhares de colunas — INFERIDO
(não medido) que pode ser lenta; medir em C1f.

### Defeitos existentes no PostgreSQL que a fase 1 expõe

**A tool vaza a existência do módulo desligado (CONFIRMADO POR LEITURA, não executado).**
As duas entradas de `lib/mcp/tools/catalogo/dados-externos.ts:13-40` NÃO declaram
`modulo: "banco_externo"`, ao contrário das de `lib/mcp/tools/catalogo/honorarios.ts:25,36`
que declaram `modulo: "honorarios"` (CONFIRMADO). A declaração é o que faz `deModuloDesligado`
(`lib/mcp/tools/catalogo/index.ts:79-81`, CONFIRMADO; efeito em `lib/mcp/tools/catalogo/tipos.ts:46-52`)
sumir com a capacidade quando o módulo está desligado. Sem ela, com o módulo desligado a tool
continua oferecida ao agente e ao MCP externo, e a resposta cai em `mensagemDeAcesso`
(`dados-externos.ts:182-197`, CONFIRMADO — sem caso `modulo_desligado`, cai no `default`):
"não foi possível abrir a conexão.". E `sem_conexao` manda "cadastrar em Integração de
dados" — tela que dá 404 com o módulo desligado (`app/app/integracao-dados/layout.tsx:13`,
CONFIRMADO). **PROPOSTA — decisão do mantenedor: Fatia 1 (PR próprio, antes de tudo; leva os dois defeitos desta seção)** (não depende do dialeto; tem testes próprios): declarar `modulo: "banco_externo"` nas duas entradas e acrescentar o caso `modulo_desligado` a `mensagemDeAcesso`.

**Nome da tabela com maiúscula (CONFIRMADO POR LEITURA, não executado).** A busca no
catálogo compara em minúscula (`candidatas`, `dados-externos.ts:433`, CONFIRMADO), mas
`colunasDaTabela(acesso.pool, schema, input.tabela)` (419/441, CONFIRMADO) e `pedido.tabela`
(465, CONFIRMADO) usam o texto do MODELO — e a consulta de `colunasDaTabela` compara por
igualdade exata (`c.table_name = $2`, `introspeccao.ts:136`, CONFIRMADO). Numa tabela chamada
`"Pedido"` (comum em aplicações com ORM), o modelo manda `pedido`, o catálogo acha, e a
segunda consulta não acha — o agente recebe `tabela_nao_encontrada` ("essa tabela não
existe. Confira o nome com crm_describe_external_data.", 447-451) quando ela existe (e a resposta devolve o mesmo texto, `tabela:
input.tabela` em 527, não o nome real). As linhas 434-436 são o outro caso: nem o catálogo achou ("não encontrei essa tabela."). No MySQL em Linux os nomes também diferenciam maiúscula
(INFERIDO). **PROPOSTA — decisão do mantenedor: mesmo PR do defeito do módulo desligado (Fatia 1, que sai antes de tudo)** (mexe nas linhas que o dialeto reescreve de todo jeito): usar `escolhida.nome` (o nome real do catálogo) nas duas
chamadas e cobrir com teste de unidade da tool (tabela `Pedido` pedida como `pedido`).

## Fontes liberadas

**DECIDIDA nesta proposta**: o MySQL só sai junto com esta lista. Hoje o
assistente recebe "a chave do armário inteiro": vê todas as tabelas que o usuário do banco
enxerga. Isso custa token (a lista inteira volta ao modelo) e é perigoso (num WordPress,
`wp_users` e `wp_options` ficam à vista). A lista resolve as duas coisas: o administrador
marca o que o assistente e a grade podem ver, com uma descrição curta. Consulta salva e
cópia em cache ficam de fora (ver "Fora de escopo").

### Revisão da D6 da Spec 20

**PROPOSTA — decisão do mantenedor.** A D6 da Spec 20 diz hoje: "Qualquer tabela da conexão, sem allowlist" (`docs/specs/20-spec-banco-de-dados-externo.md:26`, CONFIRMADO), e o mapa repete o argumento no cartão `card-nao-ligacao`: "uma allowlist seria uma segunda lista para manter em sincronia com um schema que muda todo dia" (`docs/architecture/banco-de-dados-externo.architecture.json:336-339`, CONFIRMADO). Esta spec REVISA essa decisão, sem apagá-la:

(a) o modo `all` (a D6 de hoje) continua existindo e é o das conexões que já existem (ficam `all`, nada muda para quem já usa); o que muda é que conexões CRIADAS depois nascem em `list`, e que existe a lista;

(b) a lista responde ao argumento do cartão porque guarda NOMES, não cópia de schema: fonte que sumiu do banco de origem é ignorada e sinalizada na tela ("não encontrada no banco"); "marcar todas" NÃO é o modo `all` — é uma lista explícita, que não inclui tabela criada depois;

(c) o cartão `card-nao-ligacao` do mapa é reescrito no PR da implementação.

A revisão pode ser recusada: nesse caso o modo `all` segue sendo o único e as fatias 2a e 2b não são aceitas.

### O filtro por cliente (#2280) e as fontes liberadas são travas complementares

A `main` já tem o filtro por cliente da conversa (migration 0558, que criou
`customer_key_column` + `customer_key_kind` em `external_db_connections` e redefiniu a view
com 20 colunas — CONFIRMADO em
`supabase/migrations/20261005200302_0558_coluna_identificadora_do_cliente_no_banco_externo.sql`;
ver o parágrafo "Na conversa, só as linhas do cliente" na Spec 20). As duas travas dividem o
trabalho: a lista desta spec decide QUAIS tabelas e colunas; o filtro do #2280 decide QUAIS
LINHAS. O filtro é opt-in por conexão (`customer_key_column` + `customer_key_kind`,
`phone`|`email`, os dois juntos ou nenhum — `lib/external-db/schemas.ts:21-22,46-47,51-63`,
CONFIRMADO), só vale durante a conversa, e o valor vem do cadastro do contato, lido pelo
servidor (`identificadoresDoContato` em `lib/mcp/tools/dados-externos.ts:143-165`, CONFIRMADO)
— nunca do modelo.

Ordem no `crm_query_external_data` (CONFIRMADO em `dados-externos.ts:342-368`): o filtro do
cliente é calculado DEPOIS de `abrirAcesso`, e a lista restringe o catálogo e as colunas
antes dele. Se a lista esconder a coluna do cliente numa fonte, a consulta na conversa FECHA
com `tabela_sem_identificador_do_cliente` (`dados-externos.ts:454-461`, CONFIRMADO — o
handler exige a coluna entre as permitidas) — nunca lê sem o filtro. Sem identificador no
contato, `cliente_sem_identificador` (:360-366). A descrição da tool já promete isso
(:325-331).

**PROPOSTA — decisão do mantenedor:** a tela de marcação (Fatia 2b) inclui automaticamente a
coluna do cliente ao marcar uma fonte quando a conexão tem `chaveDoCliente`
(`ChaveDoCliente` em `lib/external-db/types.ts:46-49`, `ConexaoExterna.chaveDoCliente` em
:42, CONFIRMADO) — sem ela, marcar a tabela e conversar daria erro sempre. O modo `all` e
as conexões existentes não mudam.

### Onde a lista mora

NÃO há tabela nova. As duas colunas da lista (`source_mode`, `sources`) entram numa migration própria (Fatia 2a).

- `source_mode text not null default 'all'` com `CHECK (source_mode in ('all','list'))` —
  `all` = comportamento de hoje (vê tudo que o usuário do banco vê); `list` = só o marcado.
- `sources jsonb not null default '[]'` com `CHECK (jsonb_typeof(sources) = 'array')` e teto
  de tamanho (proposta: `octet_length(sources::text) <= 262144` — medida determinística do
  conteúdo; `pg_column_size` mede como está armazenado, com ou sem compressão, e o mesmo dado
  poderia passar na gravação e falhar num restore — INFERIDO, documentação do PostgreSQL,
  não medido).

Por que coluna e não tabela (CONFIRMADO abrindo `docs/adr/0002-tabelas-de-modulo-num-banco-so.md`:
a decisão D9 recusa "Tabelas no baseline para todos" para módulo com dados próprios; e
`banco_externo` é módulo por FLAG — `MODULOS_OPCIONAIS_POR_FLAG` em
`lib/instalacao/modulos.ts:71-77`, chave `MODULO_BANCO_EXTERNO` em `modulos.ts:82` — cuja
tabela já está no baseline desde a 0372): uma tabela nova entraria no baseline de TODA
instalação e pediria RLS, FK e entrada no teste de isolamento; a coluna herda a RLS que já
existe (select = membro, escrita = `admin`), é apagada junto com a conexão e é trocada de uma
vez só (um `UPDATE` atômico, sem estado pela metade). O risco do `jsonb` é o anti-padrão 6 do
`CLAUDE.md` ("`jsonb` lock-in (UI lê path direto sem schema central)", seção Anti-patterns
proibidos): por isso o formato tem UM esquema central em `lib/external-db/fontes.ts` (Zod),
versionado, e a UI nunca lê caminho solto.

Formato de cada fonte (PROPOSTO): `{ schema: string, tabela: string, colunas: string[] |
null, descricao: string }` — `colunas: null` = todas as colunas visíveis, INCLUSIVE as
futuras (`null` não é uma foto das colunas de hoje: uma coluna criada depois no banco de
origem, por exemplo um hash de senha, passa a ser lida sem ninguém marcar);
**PROPOSTA — decisão do mantenedor**: a tela marca colunas EXPLÍCITAS por padrão (lista de
nomes), e `null` só por escolha consciente "todas, inclusive as futuras", com o texto de
aviso ao lado; `descricao` até 300 caracteres; até 200 fontes por conexão; até 200 nomes em
`colunas`.

A view `_safe` ganha `source_mode` e `sources_count` (= `jsonb_array_length(sources)`), e
**NÃO** o array (a lista de conexões e a tela não devem carregar o array inteiro). As listas
copiadas à mão (`COLUNAS_SEGURAS` etc.) ganham `source_mode` e `sources_count`. O array só é
lido por `carregarConexao` (`lib/external-db/credenciais.ts`, cliente de serviço, com
`organization_id` no filtro) e pelo endpoint de fontes (ver "API das fontes"). `ConexaoExterna` (`types.ts`)
ganha `sourceMode` e `fontes`.

Compatibilidade (idempotente, `add column if not exists`, o CHECK depois de normalizar):
linhas que já existem ficam `all` (nada muda para quem já usa); conexões CRIADAS depois
nascem `list` (**PROPOSTA** — `POST /connections` não recebe `source_mode` no corpo; o
`INSERT` (`connections/route.ts:111-127`, CONFIRMADO — hoje não grava `source_mode` nem
`sources`, que ainda não existem) passa a gravar `source_mode: 'list'` EXPLICITAMENTE.
NUNCA mudar o `default` da coluna para `'list'`: isso viraria as conexões existentes, e o
`update.sh` as pegaria; vale para PostgreSQL e MySQL). Consequência para quem integra por API: conexão nova criada
por token enxerga NADA até marcar as fontes — por isso o fragmento de versão avisa (ver "Destino e entrega").

### Onde a regra é aplicada (um lugar só)

Função PURA `aplicarFontes` (em `lib/external-db/fontes.ts`), chamada dentro do
dialeto/`abrirAcesso` — nunca em cada tool ou rota. Regras:

1. `listarTabelas` devolve só as fontes liberadas, com `descricao`, e nelas só as colunas liberadas;
2. `colunasDaTabela` devolve só as colunas liberadas — e é essa lista que valida projeção,
   **filtros e ordenação**: filtrar ou ordenar por coluna escondida deixaria o agente descobrir
   o conteúdo dela por tentativa;
3. projeção vazia (que hoje vira `*` em `lib/external-db/leitura.ts:150`, CONFIRMADO) vira
   lista EXPLÍCITA das colunas liberadas quando a fonte restringe colunas — nunca `*`;
4. tabela fora da lista → erro novo `fonte_nao_liberada` ("essa tabela não foi liberada pelo
   administrador desta conexão");
5. `source_mode = 'all'` = comportamento de hoje.

Vale para TODOS os leitores: as duas tools do agente, o MCP externo, as rotas da grade
(`schemas` e `tables`, hoje abertas a `viewer` — `requireRole("viewer", ...)` em
`schemas/route.ts:33` e `tables/[schema]/[tabela]/route.ts:39`, CONFIRMADO) e o Testar do
prompt (`preview.ts:152-153`, CONFIRMADO). Única exceção: a rota de catálogo completo (ver "API das fontes")
(só administrador, só para a tela de marcação). A grade mostra o mesmo que o assistente
enxerga (continuidade humano↔IA, invariante 2 do Sistema Vivo).

### Lista vazia não pode ser silêncio

Com `source_mode = 'list'` e zero fontes, as tools devolvem `sem_fontes_liberadas` ("nenhuma
tabela foi liberada para o assistente nesta conexão; peça a um administrador para marcar em
Integração de dados"); o `motivoDoVazioExterno` (`dados-externos.ts:175-180`, CONFIRMADO)
registra o motivo (conta como falha no painel de capacidades); e a tela da conexão mostra o
aviso amarelo "o assistente ainda não enxerga nada". O texto de `sem_conexao` não muda (é
outro caso: nenhuma conexão ativa).

### API das fontes (aditiva)

Três rotas novas sob `/api/v1/external-db/connections/:id/` (padrão da seção API):

- `GET catalog` (administrador): catálogo COMPLETO sem filtro de fontes, ao vivo, mesma
  guarda de host e mesmos erros de `schemas/route.ts`.
- `GET sources` (`viewer`): devolve `source_mode` e a lista.
- `PUT sources` (administrador): troca modo E lista inteira de uma vez; validação Zod; NÃO
  exige que a fonte exista no banco no momento do PUT — fonte que sumiu fica aceita e a tela
  a marca "não encontrada no banco", porque o catálogo ao vivo pode estar fora do ar. `PUT` é
  naturalmente idempotente (repetir o mesmo corpo grava o mesmo estado — sem `Idempotency-Key`).
  O `PUT` declara `requireSupportWrite()` ANTES do efeito (guarda de efeito antes dos clientes
  service role — `lib/impersonate/support.ts:27-31`, CONFIRMADO; o teste de cobertura de
  efeitos (`tests/unit/suporte-cobertura-de-efeitos.test.ts`) varre os handlers POST/PUT/PATCH/DELETE,
  CONFIRMADO), usa o mesmo `checkRateLimit` das outras escritas, `ok()`/`fail()`,
  `X-Request-Id`, filtro de `organization_id` vindo do contexto (nunca do corpo) e `audit()`
  com ação `external_db_sources.updated` e metadata de CONTAGENS (modo, nº de fontes), sem
  nomes de coluna. Autenticação e limite (CONFIRMADO abrindo as vizinhas): as rotas do
  conector usam só cookie de sessão (`requireRole`) — nenhuma importa o helper de auth dual
  (`auth-dual` não aparece em `connections/route.ts`, `[id]/route.ts`, `schemas/route.ts`
  nem `test/route.ts`); bearer `dsk_` segue a regra do `CLAUDE.md` (habilitar é rota a
  rota, e o `proxy.ts` exige entrada em `lib/auth/public-paths.ts`) — como as vizinhas não
  aceitam bearer, estas três também não nesta fase. Limite de taxa: as vizinhas já usam
  `checkRateLimit` — `external-db:read` (120/60s, `schemas/route.ts:38`),
  `external-db:write` (30/60s, `connections/route.ts:72`, `[id]/route.ts:78`),
  `external-db:test` (10/60s, `test/route.ts:44`); o `GET catalog` leva chave própria de
  leitura porque cada chamada vai AO VIVO ao banco do cliente, e o `PUT sources` usa a
  mesma chave de escrita das vizinhas. O PUT muda `updated_at`, e a chave do pool inclui a versão
  (`conexao.ts:35-37`, CONFIRMADO) — o pool da conexão é recriado a cada PUT; custo pequeno,
  aceito.

### Tela das fontes (sem porta nova)

Continua em `/app/integracao-dados/[id]`, sem porta nova. No explorador
(`[id]/page.tsx` + `_components/ExploradorDeDados`, que traduz com `useT` — CONFIRMADO),
painel "O que o assistente pode ver": administrador edita, os demais só leem. Árvore de
tabelas e views do catálogo completo com caixas de marcar, colunas expansíveis (padrão:
explícitas — a lista de nomes; "todas, inclusive as futuras" só por escolha consciente, com
o aviso ao lado, porque `colunas: null` passa a ler coluna criada depois sem ninguém
marcar), campo de descrição (≤300), contador "N de M liberadas", marcação "não encontrada no
banco" em amarelo para fonte que sumiu, e o seletor de modo com aviso forte no modo `all`
("o assistente enxerga todas as tabelas que o usuário do banco enxerga"). Para marcar em
volume: caixa de busca por nome, filtro "só views" e os atalhos "marcar todas as visíveis" e
"limpar" — "marcar todas" NÃO é o mesmo que o modo `all`: é uma lista explícita, que não
inclui tabela criada depois. O `describe` devolve as fontes na ordem em que aparecem na
lista salva (ordem de marcação); reordenar fica fora das fatias 2a e 2b. O painel se apoia
no fieldset "Cliente nas conversas" que o #2280 já pôs no `FormularioDeConexao.tsx`
(:46-50,116-119,160-163,332-375); quando a conexão tem `chaveDoCliente`, o painel marca a
coluna do cliente automaticamente (ver "O filtro por cliente (#2280) e as fontes liberadas
são travas complementares"). A lista de conexões
(`ListaDeConexoes.tsx`) mostra "N tabelas liberadas" ou "tudo liberado". Texto em português
simples, passando por `traduzir`/dicionário. Ao criar a conexão e ao ter um Testar
bem-sucedido, a tela leva o administrador direto ao painel "O que o assistente pode ver" com
o próximo passo ("Falta escolher o que o assistente pode ler") — conexão nova nasce
enxergando nada, e a primeira impressão não pode ser um assistente mudo sem explicação; a
lista de conexões mostra o aviso enquanto a lista estiver vazia. A prova pela tela tem de
cobrir esse passo (é a jornada de primeira impressão da doutrina de QA Visual). Prova pela
tela (Definition of Done do `CLAUDE.md`, item 12) nos dois motores.

### O que o modelo recebe

`describe` devolve só as liberadas, com a `descricao` ao lado do nome, na ORDEM da lista do
administrador — hoje a ordem é alfabética (schema, tabela: `introspeccao.ts:119-124`,
CONFIRMADO) e o corte em 60 tabelas (`MAX_TABELAS_DESCRITAS` em `dados-externos.ts:46`, corte
em :262-263, CONFIRMADO) pode esconder
justamente as últimas (`wp_users`, `wp_woocommerce_*`). E o `describe` ganha teto de bytes:
reaproveita `max_response_bytes` da conexão (`maxResponseBytes` em `credenciais.ts`,
CONFIRMADO), com `truncado: true` — sem limite novo.

### Custo de IA (estimativa INFERIDA)

Cálculo a partir dos limites do código, não medido em tráfego real: `describe` sem teto
chega a 60 tabelas × 60 campos ≈ 200 KB ≈ 50–60 mil tokens no pior caso; `query` tem teto
padrão de 30 mil bytes ≈ 8 mil tokens, ajustável até 1 MiB. A lista de fontes e o teto de
bytes do `describe` existem para manter esse custo sob controle.

## Segurança

1. **SSRF/TCP:** `guardas.ts` reaproveitada sem afrouxar — loopback/metadata/CGNAT/multicast
   continuam bloqueados; LAN permitida (caso real do self-host). Revalidada a cada abertura
   de pool (`acesso.ts`). Janela de DNS-rebinding permanece declarada.
2. **Leitura real no MySQL:** transação `READ ONLY` + geração exclusiva de `SELECT` +
   usuário `GRANT SELECT` + aviso de privilégio excessivo no teste (D5). A garantia para
   MyISAM é NÃO MEDIDO (C1a, C1d).
3. **Arquivo local:** defesa `LOCAL_FILES` proposta, a confirmar em C1b.
4. **LGPD:** PII fora do audit; sem valores de filtro na querystring (regra atual mantida).
   Duas metades que a frase antiga escondia: o dado vai ao provedor de IA (os tokens que
   entram no modelo são os mesmos — ver "Fora de escopo") E fica no rastro do agente
   (`ai_agent_runs.tool_calls`). A redação cobre chaves chamadas `authorization`,
   `api_key`, `token`, `password`, `cpf` e corta string em 500 caracteres — NÃO cobre
   `email`, `telefone`, `endereço`, `hash`. Por quanto tempo fica: NÃO MEDIDO como ausência
   (varri `app/api/v1/cron`, `lib/retencao`, `lib/lgpd` e `delete from
   public.ai_agent_runs` no baseline sem achar expurgo por tempo; um grep só prova o que
   varreu; a migration 0587, retenção das tabelas da IA, entrou na `main` seguinte `548d70cd`
   e purga sete outras tabelas sem tocar `ai_agent_runs`, conferido no arquivo dela). O que existe é a redação por contato (`fn_lgpd_redigir_tool_calls`, definição
   no baseline em :43935-43960, última menção em :44042 — cada passo vira `{step,
   tool_name, redacted}`, o conteúdo sai, o esqueleto fica). Isso vale para o PostgreSQL
   de HOJE, independente do MySQL e da lista. Ver "Quais tabelas do CRM a leitura toca".
5. **Prompt injection:** conteúdo externo é dado, nunca instrução (aviso fixo mantido).
6. **Credencial:** nunca em querystring, nunca em log; senha só decifrada no escopo da leitura.

## Testes e prova

### Unidade

- Por dialeto: `montarConsulta` (snapshot do SQL: crase/`?`/`ESCAPE '!'`/`LIMIT`),
  escape do `contem` (valor com `%`, `_`, `!`), `execute` com `null`, introspecção recusando
  schema diferente do banco da conexão, `schemas` (`db_type`, defaults de porta por motor).
- Interpretador de `SHOW GRANTS` como função pura, com fixtures INFERIDAS (o formato real
  da saída é NÃO MEDIDO e fica para a integração confirmar): `GRANT SELECT ON app.* TO 'leitor'@'%'`
  (sem aviso); `GRANT ALL PRIVILEGES ON *.* TO 'root'@'%'` (aviso); `GRANT SELECT, INSERT ON app.* ...`
  (aviso); `GRANT USAGE ON *.* ...` (sem aviso); `GRANT 'leitura' TO 'u'@'%'` (role → "não consegui
  conferir os papéis..."); presença de `GRANT OPTION` (aviso); `SELECT` em `*.*` ou em
  `banco.*` (aviso de leitura ampla, ver "O que o agente consegue ver").
- Unidade de `aplicarFontes`: fonte fora da lista (`fonte_nao_liberada`); coluna escondida em
  projeção, em filtro e em ordenação; projeção vazia com colunas restritas vira lista explícita
  (nunca `*`); modo `all` = comportamento atual; lista vazia (`sem_fontes_liberadas`).
- Tool com o dialeto MySQL simulado: `conexao.motor` presente (se o campo `motor` for adotado),
  tabela com maiúscula (ver defeito acima), módulo desligado (ver defeito acima); e a lista
  devolvida a `describe` nunca contém `information_schema`, `mysql`, `performance_schema`, `sys`.
- Rota `/test`: sucesso sem aviso limpa os dois campos; sucesso com aviso grava só
  `last_test_aviso`; falha grava só `last_test_error` (e limpa `last_test_aviso`).

### Rotas

- `PUT sources` com `viewer` → 403; com administrador de OUTRA organização → não altera;
  `GET catalog` só administrador.
- Rota `POST /connections`: a linha criada tem `source_mode = 'list'` e `sources = []`.
- `PUT sources` com corpo inválido (mais de 200 fontes, `descricao` com mais de 300
  caracteres, `colunas` com mais de 200 nomes, `sources` que não é array) → 400 com `fail()`.
- `POST /connections` e `PATCH /connections/:id` com `source_mode` ou `sources` no corpo →
  recusados (os schemas são `.strict()`, `schemas.ts:82,105`, CONFIRMADO).
- `GET sources` por `viewer` devolve a lista mas NUNCA a senha nem qualquer campo cifrado.
- `GET catalog` com o id de uma conexão de OUTRA organização → não encontrada (a rota
  vizinha `schemas/route.ts` carrega a conexão com filtro de organização
  (`abrirAcesso(createAdminClient(), activeOrg.orgId, id)`, :45, CONFIRMADO) e, para conexão
  que não é da organização, `respostaDeAcesso("nao_encontrada")` devolve 404 `not_found`
  (`app/api/v1/external-db/_falha.ts:45-46`, CONFIRMADO); `catalog` repete exatamente
  isso — é a rota que fura a lista de fontes.

### Isolamento e schema

- Cada migration + seu apêndice do baseline é coberta pelo `pnpm test:db` (seção Testes do `CLAUDE.md`:
  install do zero + update com dado, no CI). O teste de isolamento
  (`tests/invariants/rls-isolation.test.ts:491-498,697`, CONFIRMADO — seed com colunas à mão e
  tabela listada pelo nome) passa com as colunas novas sem mudança, porque elas têm
  `default`/anulável e a RLS é a mesma da tabela.
- Caso de `pnpm test:db:update` (`bash scripts/test-update-com-dados.sh`,
  `package.json:28`, CONFIRMADO — install, seed, re-aplica com `ON_ERROR_STOP=1`): uma
  conexão que existia ANTES da migration continua `all` depois dela. O ponto exato do seed
  dessa linha é NÃO MEDIDO (o script semeia, mas não confirmei linha de
  `external_db_connections` nele) — o caso entra como PROPOSTA.

### Integração (precisa de MySQL de verdade)

- Casos que viram gate quando houver job que os execute: C1a (MyISAM + `READ ONLY`), C1b
  (`LOAD DATA LOCAL` hostil), C1c (TLS `disable`/omitido e `verify-ca`), C1d (trava de
  metadados), C1e (standalone leva o `mysql2`), C1f (catálogo de WP real), C1g (catálogo
  respeita privilégios), `describe` + `query` com collation/acentos (`ç/ã/CAIXA`) nos dois
  motores.
- O teste de integração com MySQL roda em um job de CI; sem job que o execute, ele não é
  gate e não prova nada. O check obrigatório `e2e` (`.github/workflows/e2e.yml`) sobe
  Supabase local, WAHA e Redis (CONFIRMADO: seção Testes do `CLAUDE.md`, item `e2e`; WAHA/Redis via `docker run`
  em `e2e.yml:1387-1460`) e **não tem MySQL**. **PROPOSTA — decisão do mantenedor**: o E2E
  MySQL entra na lista `FORA_DO_CI` com o motivo escrito (a variável exige motivo por spec —
  `e2e.yml:1212-1241`, CONFIRMADO; e `tests/unit/e2e-cobertura-completa.test.ts:185-200`
  reprova spec no disco sem lista), rodando no job de integração até a decisão de pôr MySQL
  no `e2e` obrigatório.
- O job de CI com MySQL (Fatia 4a) altera `.github/workflows`, e mudança em
  `.github/workflows` vinda de fork exige todos os passes da triagem MAIS leitura linha a
  linha (tabela de raio de dano em `triagem/TRIAGEM.md:133-140`, linha 140, CONFIRMADO).

### Pela tela e em par

- A prova pela tela nos dois motores (Definition of Done do `CLAUDE.md`, item 12) continua
  exigida antes do merge, feita manualmente com evidência em `evidence/<entrega>/`
  (seção QA Visual com Recursos Reais do `CLAUDE.md`, registro obrigatório — CONFIRMADO):
  criar → testar → explorar → consultar, nos dois motores; loopback recusado;
  `filtro_sem_valor` ensina em vez de entregar a tabela; audit sem PII (mesmo teste da Spec 20).
- E2E das fontes pela tela: marcar uma tabela, ver o assistente listar só ela, tentar outra e
  receber `fonte_nao_liberada`.
- O caso de aceite que passa pelo agente vem em par (lei em `docs/doctrine/prova-em-par.md:10-20`:
  o par é a unidade — `prova-em-par.md:10-12`): a tool chamada direto E o turno do agente com
  o MESMO texto cru (perguntando por um dado de uma view, ou marcando uma tabela e tentando
  outra); só vale se concordarem; discordância significa que se mediu o modelo.

### Sabotagens obrigatórias

Teste que não fica vermelho com a linha sabotada não guarda nada; cada uma abaixo deixa um
teste vermelho: trocar `ESCAPE '!'` por barra; remover o filtro `table_schema`; remover a
omissão de `ssl`; fazer o interpretador ignorar `ALL PRIVILEGES`; tirar `aplicarFontes` do
`listarTabelas`; aceitar filtro em coluna escondida; deixar a projeção vazia virar `*` com
colunas restritas; ignorar `source_mode = 'list'`; trocar o `default` da coluna para
`'list'` (deve deixar vermelho o caso de conexão antiga); tirar o `source_mode: 'list'` do
`INSERT` (deve deixar vermelho o teste da rota).

## Ordem de entrega

Cada fatia sai num PR próprio:

| Fatia | O que entrega | Depende de | Toca schema? | Toca tela? |
|---|---|---|---|---|
| 1 | Os dois defeitos da seção "Defeitos existentes": as ferramentas somem com o módulo desligado + nome da tabela com maiúscula | — | Não | Não |
| 2a | Fontes liberadas no banco, no núcleo e na API (`source_mode`, `sources`, `aplicarFontes`, rotas `catalog`/`sources`); nasce o `Dialeto` só com PostgreSQL | 1 | Sim | Não |
| 2b | Painel "O que o assistente pode ver" (marcação de fontes) | 2a | Não | Sim |
| 3 | O `Dialeto` ganha `consultar`, `testar`, `fechar` e a escolha pelo `db_type`; refatoração sem mudar comportamento | 2a | Não | Não |
| 4a | MySQL: `db_type`, `last_test_aviso`, driver, dialeto, interpretador de `SHOW GRANTS`, runbook | 3 | Sim | Não |
| 4b | Seletor de motor e aviso de privilégio na tela | 2b, 4a | Não | Sim |
| 5 | Tamanho da resposta no registro de auditoria (separável) | — | Não | Não |

Princípio: cada fatia entrega software que funciona sozinho; as fatias que tocam schema passam pelo teste de banco do CI; a prova pela tela vale a partir das fatias 2b e 4b.

Medido contra a `main` `17a67d3da`, que já contém o #2280; fatias 1 e 2a partem desse handler.

## Destino e entrega

- **Destino: módulo oficial opcional que já está no produto (`banco_externo`, migration
  0384), evoluído.** Pela pergunta da doutrina (`docs/doctrine/extensoes.md:26`): "se nenhuma
  organização desta instalação ativar isto, a operação comum continua inteira?" — sim, o que
  em princípio admitiria extensão (`extensoes.md:28`: "Se sim, o recurso pode ser extensão").
  Mas o contrato de extensões que existe hoje **não alcança** um driver de banco, uma tela
  nem uma ferramenta de IA: o pacote não recebe cliente Supabase, ambiente, shell, JavaScript,
  SQL nem dados do CRM (`extensoes.md:58-62`); não executa código e não traz dados de domínio
  (`docs/specs/extensoes-declarativas-v1.md:13,15`); o pacote é JSON sem `script` nem `SQL`
  (`docs/specs/extensoes-declarativas-v1.md:19`); e cada concessão só abre uma porta que o núcleo já tem
  (`extensoes.md:62`, `docs/specs/extensoes-declarativas-v1.md:118`). "Extensão" fica como destino futuro,
  sem promessa. A expressão "módulo oficial" segue a ADR-0002 (aceita em 17/09/2026).
- **Dependência nova (Fatia 4a)**: `mysql2` entra em `dependencies` do `package.json` com
  `pnpm-lock.yaml` atualizado (`mysql2` não está instalado — CONFIRMADO por busca no
  `package.json`, que só tem `pg`; licença e versão NÃO MEDIDAS, a conferir ao adicionar).
  O `Dockerfile.worker:16-18` faz `pnpm install --frozen-lockfile` (CONFIRMADO), então o
  worker recebe a dependência sozinho. Para a imagem do app o risco é outro:
  `next.config.ts` usa `output: "standalone"` fora da Vercel (`next.config.ts:17`, CONFIRMADO) e o comentário
  do próprio arquivo explica que o standalone copia SÓ o que o rastreamento detecta
  (`next.config.ts:18-52`, CONFIRMADO — precedentes do `@swc/helpers` e do `pdfjs-dist`).
  Decisão: a fachada importa os dois dialetos com `import` ESTÁTICO (nunca `import()` com
  caminho calculado), para o rastreamento enxergar o `mysql2` — INFERIDO (comportamento do
  rastreamento com `mysql2` não medido); a prova é `pnpm build` + `next start` com uma
  conexão MySQL de teste (C1e). O peso que o `mysql2` acrescenta é uma medida a FAZER, não uma
  que já existe: o `build-and-size` (`.github/workflows/perf.yml`, CONFIRMADO) roda
  `pnpm build` em :37-38 e publica só o tamanho do `.next` no resumo em :47-53 — não
  constrói a imagem Docker e não compara com limite (a linha 55 diz que limiares, Lighthouse
  e bundle-analyzer, ficaram adiados). **PROPOSTA — decisão do mantenedor**: a Fatia 4a
  registra o tamanho do `.next` antes e depois de acrescentar o `mysql2` (no resumo do
  `build-and-size`, que é onde a triagem pediu a medida) e declara a diferença no PR. O peso
  da imagem Docker em si é NÃO MEDIDO (não localizei job que o meça).
- Fragmento em `.changes/` (formato em
  `docs/doctrine/versionamento.md:124-133`; exemplo em
  `.changes/canal-desativado-nao-entra-na-inbox.md`: `impacto`, `secao`, `titulo` + prosa
  para o operador) — **um por fatia, PROPOSTA — decisão do mantenedor**: Fatia 1,
  `nada_mudou` (correções de defeito, nada de novo para o operador); Fatia 2a,
  `capacidade_nova` (conexões novas nascem com a lista vazia — o assistente só enxerga o
  que for marcado — e conexões já existentes não mudam, nascem `all`); Fatia 2b,
  `capacidade_nova` (painel "O que o assistente pode ver"); Fatia 3, `nada_mudou`
  (refatoração interna sem mudar comportamento); Fatia 4a, `capacidade_nova` (o conector
  fala MySQL) + dependência `mysql2`; Fatia 4b, `capacidade_nova` (seletor de motor e aviso
  de privilégio na tela); Fatia 5, `capacidade_nova` (custo por ferramenta no painel).
- Textos novos da tela passam pela tradução: `FormularioDeConexao` usa `t()` (`useT`) e a
  página usa `traduzir()`/`dicionario` (padrão CONFIRMADO em
  `app/app/integracao-dados/_components/FormularioDeConexao.tsx` e `page.tsx:50-53`) —
  nenhuma string de motor vai chapada em português no JSX.
- Runbook do usuário MySQL só de leitura (`GRANT SELECT`) como entregável da Fatia 4a, caminho
  **PROPOSTO**: `docs/runbooks/banco-externo-mysql.md` (`ls docs/runbooks | grep -i banco`
  hoje devolve vazio — CONFIRMADO). O runbook ensina três passos: criar o usuário só de
  leitura, criar a view e conceder `SELECT` só nela, e marcar a view em "O que o assistente
  pode ver".
- Documentação (Definition of Done do `CLAUDE.md`, item 10 — "Doc atualizada se mudou
  contrato"): a Spec 20 ganha duas notas, uma por fatia — na Fatia 2a, a revisão da D6 (é
  ela que cria a lista); só na Fatia 4a, a nota "desde a Spec 23 o conector também fala
  MySQL" — ela afirma hoje conector só-PostgreSQL na seção Objetivo
  (`docs/specs/20-spec-banco-de-dados-externo.md:12-13`, CONFIRMADO). As notas são
  entregáveis dos PRs das fatias (**NÃO** editar a Spec 20 agora).

## Fora de escopo

- Escrita no banco externo; sync/import para entidades do CRM; console SQL livre.
- MSSQL/Oracle/SQLite/ODBC/FDW; WP-REST/senha de aplicação (futura família HTTP).
- `mariadb` como rótulo separado (entra com a adaptação `max_statement_time`, sem nova spec
  se só alias + prova).
- **Cópia/cache dos dados em tabela do CRM, relida de tempos em tempos** — fica velha
  (pedido, saldo mudam), não reduz o custo de IA (os tokens que entram no modelo são os
  mesmos), e traria dado pessoal de terceiros para o nosso banco (retenção e LGPD); para
  catálogo que muda pouco, revisitar importando para Produtos/Base de conhecimento, que já
  existem.
- **Consulta salva por fonte** (filtros fixos definidos pelo administrador) — evolução natural
  da lista, adiada.
- **Teto de leituras externas por turno** — o disjuntor existente
  (`lib/agent-engine/agent/tool-breaker.ts:7-14`, CONFIRMADO: barra repetição em três modos —
  mesma tool + mesmos args falhando, mesma tool falhando com args diferentes, e tool
  read-only devolvendo o mesmo resultado sem progresso) já barra repetição idêntica; medir
  antes de criar teto novo.
- **Tamanho da resposta no audit (PR próprio, separável)**: gravar o TAMANHO da resposta
  (bytes, nunca o conteúdo) no registro `mcp.tool_called`, para o painel mostrar custo por
  ferramenta. Hoje `lib/mcp/audit.ts:61-76` grava argumentos (redigidos/truncados), duração e
  resumo — sem tamanho (CONFIRMADO) — então o custo por ferramenta não é mensurável. Tocaria
  `lib/mcp/audit.ts`, `lib/ai/runtime/tools.ts` e `lib/mcp/server.ts`: código compartilhado
  por todas as tools, por isso PR próprio. Números em "Custo de IA (estimativa)".
- **Rastro das ferramentas de banco externo sem conteúdo (PR próprio, adiado)**: o rastro em
  `ai_agent_runs.tool_calls` guardar só tabela, nomes de colunas e contagem de linhas
  (nunca o conteúdo). Tocaria `lib/ai/runtime/serialize.ts` (compartilhado por TODAS as
  ferramentas), por isso PR próprio — e NÃO faz parte de nenhuma fatia desta spec.
  **PROPOSTA — decisão do mantenedor**.

## Living System Checklist — dialeto MySQL

1. Quem me alimenta? Conexões `mysql` em `external_db_connections` (cadastro em `/app/integracao-dados`). As fontes marcadas alimentam o dialeto (`aplicarFontes`).
2. Quem eu alimento? Grade do explorador + tools `crm_describe/query_external_data` (mesmos consumidores do PG) — agora filtrados pelas fontes liberadas.
3. Que registro eu emito? `api_audit_log` via `audit()` (leitura e mutação, sem PII, agora com `db_type` e `source_mode` no metadata de criação) + `last_test_*` na linha da conexão + **aviso de privilégio excessivo** (`last_test_aviso`, visível na tela como aviso amarelo) + rastro `ai_agent_runs.tool_calls` (com conteúdo — ver item 4 de Segurança).
4. Onde eu apareço na tela? Explorador `/app/integracao-dados/[id]` + seletor de motor no formulário (desabilitado ao editar) + aviso amarelo de privilégio (`last_test_aviso`) + painel "O que o assistente pode ver".
5. Por qual porta se chega? Mesmas rotas `/api/v1/external-db/*`; sem porta nova (sem registro de navegação novo).
6. Qual meu anti-morte? Leitura pura: nenhum — com justificativa: falha vira erro-texto que ensina (`filtro_sem_valor`, `tabela_nao_encontrada`, `fonte_nao_liberada`, `sem_fontes_liberadas`) em vez de silêncio, e a tela avisa quando a lista está vazia.
7. Onde se configura? Formulário da conexão (motor/porta/TLS/limites) + marcação de fontes por conexão; sem conexão, `sem_conexao` visível; lista vazia, aviso amarelo `sem_fontes_liberadas`.
8. Qual a continuidade? IA↔humano inalterada: erro-texto para o modelo + explorador para o humano conferir a mesma tabela.
9. Qual meu laço de retorno? `motivoDoVazio` (erros contam como falha no painel de capacidades — incluindo `fonte_nao_liberada` e `sem_fontes_liberadas`) + `last_test_error` visível + **aviso de privilégio excessivo** (`last_test_aviso`): conexão criada com usuário escritor passa a se declarar insegura em vez de parecer saudável.
10. Atualizei o mapa? Sim: `docs/architecture/banco-de-dados-externo.architecture.json` ganha o nó do dialeto MySQL, o nó da interface `Dialeto` e o nó "fontes liberadas" (tela de marcação → conexão → dialeto → tools/grade), cada um com 2+ arestas — nós existentes conferidos: `pool` (`conexao.ts`), `introspeccao`, `leitura`, `acesso`, `migration0372`, `safeview`, `apiLeitura`, `toolsAgente` (linhas 35-162 do JSON).

## Invariante de vocabulário

`db_type` com CHECK pede uma linha em `PARES` de
`tests/invariants/vocabulario-banco-x-typescript.test.ts` (estrutura CONFIRMADA nas linhas
45-50: `{tabela, coluna, arquivo, simbolo}`) apontando `lib/external-db/types.ts` /
`TipoBanco` — e `source_mode`, com o mesmo formato de CHECK, pede a segunda linha apontando
`lib/external-db/types.ts` / `ModoDeFontes = "all" | "list"` (tipo novo, a criar junto com a
coluna). Observação (sem mandar corrigir nesta fase): `ssl_mode` também tem CHECK
(`0372`: `external_db_connections_ssl_conhecido`) e não está no `PARES` — conferido por
busca: nem `ssl_mode` nem `external_db` aparecem no teste.
