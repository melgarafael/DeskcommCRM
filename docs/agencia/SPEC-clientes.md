# Spec: `clientes` — os clientes da agência e as contratações

> Fase 2 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **rascunho para aprovação** (24/10/2026).
> Irmãos da fase: [`acervo`](SPEC-acervo.md), [`tarefas`](SPEC-tarefas.md). Depende de [`equipe`](SPEC-equipe.md).

## Objetivo

Um cadastro único de **quem a agência atende**, com o que cada um contratou e
quem da equipe cuida dele. É a peça que as tarefas, o Drive, a trilha (Fase 4), os
contratos (Fase 6) e as aprovações (Fase 7) vão referenciar.

### Histórias

- Como **dono**, cadastro um cliente com os dados da empresa e escolho quem da
  equipe atende ele.
- Como **dono**, registro o que ele contratou: um pacote recorrente montado sob
  medida (serviços e quantidades) ou um serviço avulso — e mais contratações ao
  longo do tempo.
- Como **dono**, trago de uma vez os clientes que **já existem** como organizações
  na central, sem redigitar nada.
- Como **membro** com "só os clientes que atende", vejo só os clientes em que fui
  colocado.

## Decisões (propostas)

| # | Decisão | Por quê |
|---|---|---|
| C1 | O cliente da agência é um **cadastro próprio** (`agencia_clientes`), com ponteiro **opcional** para a organização dele no CRM (`organization_id`). | Nem todo cliente tem organização no dia em que entra (o prospect da Apresentação ainda não tem), e a organização é do cliente — o cadastro é da agência. |
| C2 | Na ficha, **"Ligar à organização"** (escolhe uma organização da central ainda sem cliente) e **"Criar organização no CRM"**, que abre o cadastro de empresas do painel admin (`/admin/tenants`) — criar uma organização tem fluxo próprio (dono, convite, plano) e não é reescrito aqui; depois de criada, ela é ligada pelo mesmo campo. (Ajuste da construção, 24/10/2026: a primeira versão dizia que o botão criava direto.) E **"Importar das organizações"**: lista as organizações da central que ainda não são cliente e cria o cadastro de cada uma marcada. | D7 do mapa (todo cliente tem organização) e o pedido de criar as pastas dos clientes que já existem. |
| C3 | **Situação do cliente** (vocabulário fixo): `prospeccao` → `apresentacao` → `fechamento` → `aguardando` (assinar/pagar) → `ativo` → `pausado` / `encerrado`; e `perdido` / `remarketing`. Nesta fase a situação é escolhida à mão; na Fase 4 a trilha passa a movê-la sozinha. | Já deixa o funil das Etapas 1–3 nomeado, sem esperar a trilha. |
| C4 | **Contratação** é linha própria: `recorrente` ou `avulsa`, lista de serviços, quantidades por mês (vídeos, fotos, artes, posts), início, fim e situação. Sem valores nesta fase — dinheiro entra com os contratos (Fase 6). | O pacote é sob medida (sem planos fixos) e muda com o tempo. |
| C5 | **Quem atende**: lista de membros por cliente. "Só os clientes que atende" (chave do membro, Fase 1) passa a valer aqui. | Pedido do dono na Fase 1. |
| C6 | Um cliente pode ter **várias empresas** (grupo), como o formulário já aceita: a empresa principal no cadastro, as outras numa lista com nome e CNPJ. | O formulário atual repete CNPJ, site e endereço por empresa. |

## Dados

Migration nova (próximo número da faixa do fork, depois do 9003) + apêndice no
`baseline.sql`, **antes** da varredura de anon. Tabelas da instalação, como as da
Fase 1: RLS ligada, `revoke all` de `anon`/`authenticated`, leitura e escrita pelo
servidor depois do guarda.

```sql
create table if not exists public.agencia_clientes (
  id               uuid primary key default gen_random_uuid(),
  nome             text not null,                 -- nome fantasia, o que a equipe fala
  razao_social     text,
  documento        text,                          -- CNPJ ou CPF, só dígitos
  segmento         text,                          -- clínica, loja, restaurante…
  responsavel_nome text,
  whatsapp         text,                          -- E.164
  email            text,
  cidade           text,
  instagram        text,
  site             text,
  observacoes      text,
  situacao         text not null default 'prospeccao',
  organization_id  uuid unique references public.organizations(id) on delete set null,
  drive_pasta_id   text,                          -- spec acervo
  criado_em        timestamptz not null default now(),
  criado_por       uuid references auth.users(id) on delete set null,
  constraint agencia_clientes_situacao check (situacao in
    ('prospeccao','apresentacao','fechamento','aguardando','ativo','pausado','encerrado','perdido','remarketing'))
);

create table if not exists public.agencia_clientes_empresas (   -- C6
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.agencia_clientes(id) on delete cascade,
  nome       text not null,
  documento  text
);

create table if not exists public.agencia_clientes_membros (    -- C5: quem atende
  cliente_id uuid not null references public.agencia_clientes(id) on delete cascade,
  membro_id  uuid not null references public.agencia_membros(id) on delete cascade,
  primary key (cliente_id, membro_id)
);

create table if not exists public.agencia_contratacoes (        -- C4
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.agencia_clientes(id) on delete cascade,
  tipo        text not null check (tipo in ('recorrente','avulsa')),
  servicos    text[] not null default '{}',      -- vocabulário fixo no TypeScript
  quantidades jsonb not null default '{}',       -- {"videos": 8, "fotos": 20, "artes": 12, "posts": 16} por mês
  inicio      date,
  fim         date,
  situacao    text not null default 'ativa' check (situacao in ('proposta','ativa','pausada','encerrada')),
  observacoes text,
  criado_em   timestamptz not null default now()
);
```

**Serviços** (vocabulário fixo em `lib/agencia/clientes/servicos.ts`, sem CHECK —
cresce): gravação, edição de vídeo, social media, tráfego pago, identidade visual,
artes/design, site, automação, assessoria de marketing, CRM.

**Quantidades** são validadas por um schema Zod central (`quantidades.ts`), nunca
lidas por caminho solto na tela (anti-pattern 6, `jsonb` lock-in).

## Telas

| Rota | Quem vê | Conteúdo |
|---|---|---|
| `/agencia/clientes` | todo membro (filtrado por C5) | Lista com busca, filtro por situação e por quem atende; etiqueta da situação; botão "Novo cliente" (quem tem `clientes.gerenciar`) e "Importar das organizações". |
| `/agencia/clientes/[id]` | quem vê o cliente | Ficha em abas: **Dados** (empresa e contatos), **Contratações**, **Equipe** (quem atende), **Tarefas** (as do cliente, spec tarefas), **Arquivos** (pasta no Drive, spec acervo). |

Nova permissão no vocabulário: **`clientes.gerenciar`** — cadastrar, editar,
importar, mudar situação, escolher quem atende. Sem ela, o membro só vê.

## Auditoria

`agencia.cliente_criado`, `agencia.cliente_alterado`, `agencia.cliente_situacao_alterada`,
`agencia.cliente_importado`, `agencia.cliente_organizacao_criada`,
`agencia.contratacao_criada`, `agencia.contratacao_alterada`, `agencia.cliente_equipe_alterada`.

## Testes

- **Unit:** schema das quantidades; serviço fora do vocabulário é recusado; filtro
  "só os que atende" (membro vê só os seus, dono e `ve_todos_clientes` veem todos);
  importação não duplica organização já importada.
- **Invariante:** `anon`/`authenticated` não leem nenhuma tabela nova; organização
  ligada a dois clientes é recusada (`unique`).
- **Prova pela tela no teste:** importar as organizações existentes → abrir uma
  ficha → registrar uma contratação recorrente com quantidades → pôr um membro na
  equipe → entrar como esse membro e ver só aquele cliente. Em 375 e 1280 px.

## Critérios de aceite

1. Cadastrar, editar e mudar a situação de um cliente pela tela, com auditoria.
2. "Importar das organizações" cria um cliente por organização marcada, com o nome
   e o vínculo, e não repete as já importadas.
3. "Criar organização no CRM" cria a organização e liga as duas.
4. Uma contratação recorrente guarda serviços e quantidades por mês; um cliente
   pode ter várias contratações.
5. Membro com "só os clientes que atende" vê na lista e na ficha **só** os clientes
   em que está na equipe — inclusive se digitar a URL de outro (recusa no servidor).

## Perguntas em aberto

- **C3** — A lista de situações cobre o que vocês usam?
- **Serviços** — falta algum serviço na lista?
- **C2** — Na importação, a organização da própria agência (a do WhatsApp da agência) fica de fora. Mais alguma que não deve virar cliente?
