# ADR-0002 — Tabelas de módulo opcional: um banco só, criadas quando o módulo é instalado

- **Status:** aceito em 2026-09-17 pelo dono do produto
- **Data:** 2026-09-17
- **Contexto medido em:** `84788aa64` (`main`) e na branch do PR #1016
- **Lei que muda quando aceita:** [`docs/doctrine/extensoes.md`](../doctrine/extensoes.md), não-negociável 9 e a linha "Schema próprio de extensão" da tabela do que ainda não existe

---

## Contexto

Um módulo opcional com dados próprios — o primeiro é a comanda do financeiro — precisa de
tabelas. Hoje só existe um caminho para uma tabela chegar a quem instala: migration + apêndice
idempotente no `supabase/baseline.sql` + linha no MANIFEST. O kit aplica o `baseline.sql`
**inteiro**, na instalação e em toda atualização (`hostgator-setup-kit/install.sh:1820`,
`update.sh:144-156`); não existe seletor por módulo. Resultado: toda instalação recebe as tabelas
de todo módulo, inclusive quem nunca vai usá-lo.

O dono do produto fixou três condições:

1. **Ninguém opera dois bancos de dados.** Extensão que exige segundo banco não seria usada.
2. **Quem não usa o módulo não carrega as tabelas dele.**
3. **Tem de ser funcional**: instalar o módulo e usar, sem espera nem passo manual.

### O que "schema independente" nunca significou

O programa de extensões registrava que "extensão com schema realmente independente" pede um
executor do servidor e uma ADR antes. Isso foi lido como "banco independente por extensão", e a
leitura está errada por duas razões medidas:

- **Um segundo banco é impossível para esse tipo de módulo.** O Postgres não faz chave estrangeira
  entre bancos, e as tabelas do financeiro têm **23 chaves** para tabelas do núcleo
  (`organizations`, `auth.users`, `contacts`, `calendar_event_types`, `calendar_appointments`).
- **Um schema próprio no mesmo banco não é alcançável pelo app.** A API do Supabase expõe só
  `public`, `storage` e `graphql_public` (`supabase/config.toml:10`); pedir outro schema devolve
  `PGRST106`, e o kit não configura schemas expostos. Tornar um schema alcançável pediria edição
  manual da configuração do Supabase em cada instalação — o que a doutrina de packaging proíbe.

Portanto a pergunta real não é *onde* as tabelas moram — é `public`, no banco que já existe —, e
sim **quem as cria e quando**.

### Fatos medidos que moldam a decisão

| Fato | Onde foi medido |
|---|---|
| O financeiro cria **10** tabelas: 5 do caixa (núcleo, já liberado) e **5 da comanda** (`sales`, `sale_items`, `commission_rules`, `commissions`, `loyalty_ledger`) | SQL dos PRs do módulo, `create table` contados |
| As 5 tabelas vazias da comanda, com os 18 índices, ocupam **~368 KB**, 0,07% da cota do Supabase gratuito | Postgres 17 descartável |
| O schema é da **instalação**, e a ativação é por **organização** | `organization_extensions`, chave `(organization_id, installation_id)` |
| Desativar e remover **preservam dados**; apagar é outra ação | Doutrina de extensões, não-negociável 7 |
| Toda tabela criada em `public` depois do baseline nasce com permissão total para `anon`, `authenticated` e `service_role` | `baseline.sql:4887-4890` (`ALTER DEFAULT PRIVILEGES`) |
| Tabela criada depois que o baseline foi aplicado não recebe, sozinha, as proteções por tabela que o baseline aplica ao catálogo | leitura do `baseline.sql` e Postgres 17 descartável |
| O kit engole como "inofensivo" todo erro com "already exists" ao reaplicar o baseline | `update.sh:155-172` |
| Dentro de uma função, um comando que falha desfaz a função inteira | Postgres 17 descartável |
| A varredura de RLS, a de `security definer` e a da cascata de LGPD leem o catálogo de um banco montado só com o baseline | `tests/invariants/rls-completude-varredura.test.ts`, `hardening-definer-varredura.test.ts`, `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` |
| Nenhuma função `security definer` do produto faz DDL hoje | `baseline.sql`, varredura por `execute` + `create table` |

Duas consequências diretas:

- **Criar as tabelas na ativação por organização não entrega o que parece.** Bastaria uma
  organização da instalação ativar para as tabelas existirem para todas; e, como os dados se
  preservam, elas nunca mais saem. O corte possível é por **instalação**: quem nunca instala o
  módulo não tem as tabelas.
- **Tabela criada depois do baseline não herda as proteções que o baseline aplica em laço.**
  Quem cria tabela fora do baseline tem de aplicar essas proteções por conta própria, na mesma
  transação.

---

## Decisões propostas

### D1 — Um banco, schema `public`

As tabelas de módulo moram no mesmo banco e no schema `public`, como qualquer tabela do núcleo.

### D2 — O schema do módulo mora numa função provisionadora fixa

Cada módulo com dados ganha **uma** função `public.fn_<modulo>_provisionar()`. O corpo dela é o SQL
do módulo: `create table if not exists`, `add column if not exists` para as versões seguintes,
índices, CHECK, RLS e policies. O que entra pela tripla de sempre — migration + apêndice do
baseline + MANIFEST — é a **função**, não as tabelas. Criar a função não cria tabela nenhuma.

### D3 — As tabelas nascem quando o módulo é instalado na instância

O gatilho é **instalar o módulo** na instalação (administrador da plataforma, não-negociável 4),
nunca ativar numa organização. A instalação passa pelo mesmo caminho já provado das extensões:
recibo durável com chave idempotente, auditoria só quando houve transição (`applied_now`) e a
mesma trava que coordena com a atualização do núcleo (não-negociáveis 5 e 10). As tabelas aparecem
na hora, sem cron e sem reiniciar nada.

O corte é declarado como é: **por instalação**. Numa instalação com várias organizações, uma
instalação do módulo cria as tabelas para todas, isoladas por RLS.

### D4 — O argumento de segurança da função provisionadora

A função provisionadora é `security definer` e cria tabela. Ela não amplia o que o app pode fazer
porque:

- **Não tem parâmetro.** Não há nome de tabela, SQL ou organização vindo de quem chama; o efeito é
  fixo e conhecido — o mesmo argumento que sustenta a função de expurgo da auditoria (migration
  0167).
- **É idempotente.** Chamá-la de novo não muda nada além do que a primeira chamada fez.
- **A execução é só de `service_role`**: `revoke execute … from public, anon, authenticated`.
- **Não é a separação de DDL que sustenta o argumento.** A conexão de dono do banco
  (`SUPABASE_DB_ADMIN_URL`) **chega aos contêineres** quando declarada — o `docker-compose.prod.yml`
  entrega o `.env` inteiro ao app e ao worker —, e o que existe hoje é um gate que proíbe o código do
  app de usá-la (`tests/unit/env-ddl-fora-do-app.test.ts`). O argumento desta decisão é o anterior:
  a provisionadora não dá ao app nenhuma DDL que ele possa escolher.
- **Um invariante novo reprova** função provisionadora com parâmetro, com `execute` concedido a
  qualquer papel além de `service_role`, ou com corpo que referencie tabela de fora do módulo.

O caminho manual de self-host concede `execute` em todas as funções de `public` a um papel do app
(`docs/deploy-selfhost/README.md:96`). Quando esta ADR for aceita, esse passo passa a revogar
explicitamente as funções provisionadoras, e o invariante confere o resultado depois do grant.

### D5 — A função termina aplicando as proteções que toda tabela de organização precisa ter

Tabela criada fora do baseline não recebe sozinha as proteções que ele aplica ao catálogo. Por isso a
função provisionadora termina, **na mesma transação**, chamando as rotinas de proteção:
RLS ligada, `revoke all … from anon`, isolamento por organização e as policies restritivas que
valem para sessão de suporte. Essas rotinas saem do laço do baseline para funções sem parâmetro,
chamadas pelo baseline e pela provisionadora. A prova de que a tabela recém-provisionada está
protegida é feita **logo depois de provisionar**, sem reaplicar o baseline.

### D6 — Reaplicar é explícito e falha alto

Nas atualizações, o apêndice do baseline **e** a cadeia de migrations chamam a provisionadora
somente onde o módulo está instalado, para trazer as versões novas das tabelas. Como a função se
desfaz inteira ao primeiro erro e o kit engole erros com "already exists", a chamada é seguida de
uma **conferência dos objetos esperados** que reprova de forma visível. Um passo de módulo que
falha deixa o módulo marcado como suspenso, com aviso, e não deixa a atualização dizer que deu
certo.

### D7 — As funções do módulo existem mesmo sem as tabelas

As funções de negócio do módulo são criadas pela migration e pelo baseline como qualquer outra
função, mesmo onde as tabelas não existem. Elas são escritas para compilar sem as tabelas (PL/pgSQL
com `record`, nunca `tabela%rowtype`), e o invariante cria toda a cadeia com
`check_function_bodies` ligado e sem as tabelas.

### D8 — LGPD, export e varreduras alcançam o módulo

- **Anonimização e retenção** alcançam as tabelas do módulo por SQL dinâmico protegido por
  `to_regclass`: onde o módulo não está instalado, pulam sem erro. Uma cascata que citasse a tabela
  pelo nome abortaria a anonimização inteira em toda instalação sem o módulo — medido.
- **Export** que não consegue ler uma seção do módulo marca o resultado como **parcial**, nunca o
  entrega como completo.
- **Varreduras** de RLS, `security definer` e cascata de LGPD rodam também sobre um banco de teste
  **com os módulos instalados**, para que tabela provisionada não fique fora delas.

### D9 — O que foi recusado ou adiado

| Recusado ou adiado | Por quê | Reconsideraríamos se |
|---|---|---|
| **Segundo banco por módulo** | chave estrangeira não atravessa bancos; o módulo tem 23 para o núcleo, e o dono não aceita dois bancos | nunca, para módulo que referencia o núcleo |
| **Schema próprio por módulo** | a API expõe só `public`; tornar outro schema alcançável exige configuração manual por instalação | o kit passar a configurar schemas expostos sem intervenção do operador |
| **Tabelas no baseline para todos** (o módulo "dormente") | contraria a condição 2 do dono. O peso medido fica registrado aqui (~368 KB) para uma revisão com número em mãos | o dono revisar a condição 2 |
| **Executor do servidor com schema declarado pelo pacote** | vocabulário declarativo não expressa as funções PL/pgSQL do módulo; depende do agente do servidor e do cron, com espera de minutos e sem funcionar no deploy da Vercel | extensões de terceiros precisarem de dados (marco 4 do programa) — esta ADR não o substitui |
| **Tabelas genéricas com `jsonb`** | JSON validado não substitui transação, índice, chave estrangeira e invariante de um domínio financeiro | nunca, para domínio com dinheiro |
| **Criar as tabelas na ativação por organização** | o schema é da instalação e os dados se preservam; o corte por organização não existe | — |

---

## Consequências

- **Quem instala:** continua com um banco só e nenhum passo novo. Instalar o módulo cria as tabelas
  na hora; quem nunca instala termina a instalação e toda atualização sem nenhuma tabela dele.
- **Quem escreve um módulo com dados:** o SQL do módulo vai para o corpo da função provisionadora,
  as funções de negócio compilam sem as tabelas, e o módulo declara as seções de LGPD e export.
- **CI:** ganha um molde de banco com os módulos instalados e um invariante para as funções
  provisionadoras. Nenhuma lista congelada precisa aceitar exceção.
- **Doutrina:** o não-negociável 9 passa a ter uma sub-regra para tabela de módulo, e a linha
  "Schema próprio de extensão" aponta para esta ADR.

## O que esta ADR não decide

- **O desenho do caixa**, que já foi decidido como núcleo e entra pela tripla de sempre.
- **Os defeitos do SQL de cada PR do módulo**, que são tratados na revisão de cada PR.
- **Dados de extensões de terceiros** (marco 4 do programa): a função provisionadora é para módulo
  oficial revisado pelo projeto. Um pacote de terceiro continua sem poder trazer SQL.

## Aceite

**Aceita em 2026-09-17 pelo dono do produto**, com as duas confirmações que esta seção pedia:

1. o corte **por instalação**, e não por organização;
2. a função provisionadora `security definer` sem parâmetro como a única via de criação de tabela
   de módulo, com o argumento da D4.

A partir do aceite, esta é a via para módulo oficial com dados. O aceite não implementa nada: a
função provisionadora, as rotinas de proteção extraídas do laço do baseline, o molde de teste com
módulos instalados e o invariante das provisionadoras ainda precisam ser construídos e provados,
e o primeiro módulo a usá-los é a comanda.
