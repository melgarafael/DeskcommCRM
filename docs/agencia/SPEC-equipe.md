# Spec: `equipe` — área da agência, membros e funções

> Fase 1 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **aprovada** pelo dono em 23/10/2026 (E1–E6 confirmadas; sem verificação em duas etapas).
> Módulos irmãos da mesma fase: [`whatsapp-agencia`](SPEC-whatsapp-agencia.md), [`avisos`](SPEC-avisos.md).

## Objetivo

Criar a **área da agência** (`/agencia`) e quem pode entrar nela. Depois desta fase,
o dono cadastra a equipe, cada pessoa recebe um convite, cria a senha e entra numa
área que mostra só o que as funções dela permitem — sem nunca enxergar o painel
administrador, as organizações ou as credenciais da instalação.

Esta fase não traz clientes, tarefas nem calendário: entrega a porta, as chaves e a
lista de quem tem cada chave. Tudo o que vem depois se apoia nela.

### Histórias

- Como **dono**, cadastro um membro com nome, WhatsApp, e-mail, uma ou mais funções e
  a chave "vê todos os clientes / só os que atende", e o convite chega no WhatsApp dele.
- Como **dono**, crio e edito funções e escolho o que cada uma pode fazer.
- Como **membro**, abro o link do convite, crio minha senha e caio direto na área da
  agência, no celular ou no computador.
- Como **dono**, desativo um membro e ele perde o acesso na próxima tela que abrir,
  sem perder o histórico do que fez.

## Decisões desta fase (propostas — confirmar na aprovação)

| # | Decisão | Por quê |
|---|---|---|
| E1 | **Uma área só para todo mundo da agência**, em `/agencia`. O painel admin ganha a entrada "Agência" no menu, que abre essa área. O dono entra lá com tudo liberado. | Evita construir duas telas para a mesma coisa. O dono continua no painel para o resto. |
| E2 | Quem é **platform admin com escopo `full`** é tratado como dono da agência: todas as permissões, sem precisar de cadastro de membro. `support_readonly` **não** entra. | O dono já é platform admin (o `install.sh` o promove); não faz sentido cadastrá-lo de novo. |
| E3 | O módulo liga e desliga pelo mesmo mecanismo da Cobrança (`MODULOS_SO_DA_INSTALACAO`, chave `MODULO_AGENCIA` em `platform_config`). Desligado: `/agencia` responde 404 e a entrada some do menu. | Mecanismo que já existe e já é testado; as tabelas existem vazias em todo banco, como as `cobranca_*`. |
| E4 | O convite vai pelo **WhatsApp da agência** (com o link também copiável na tela), não por e-mail. | Uma instalação pode não ter `RESEND_API_KEY`; o WhatsApp da agência é o canal que a equipe já usa. |
| E5 | As tabelas da agência **não têm `organization_id`**: são da instalação, como `platform_admins`. | A agência não é uma organização-cliente; os dados dela não pertencem a nenhum tenant. |
| E6 | Permissão é um **vocabulário fixo** no código (lista abaixo). A função guarda quais itens do vocabulário ela tem; o membro tem a soma das funções. | Permissão livre em texto viraria string sem dono (anti-pattern 1 e 6). |

## Permissões

Vocabulário fixo (`lib/agencia/permissoes.ts`). Esta fase **usa** só as duas primeiras;
as outras ficam declaradas para as fases seguintes não inventarem nomes.

| Permissão | O que libera | Usada a partir de |
|---|---|---|
| `equipe.gerenciar` | Cadastrar, editar e desativar membros; criar e editar funções | Fase 1 |
| `configuracoes.gerenciar` | WhatsApp da agência, antecedência dos avisos | Fase 1 |
| `avisos.gerais` | Receber os avisos gerais da agência (ex.: "o mês de preparação do cliente X acaba em 3 dias"), além dos próprios | Fase 1 (motor) / Fase 4 (uso) |
| `tarefas.criar` | Criar tarefa | Fase 2 |
| `tarefas.atribuir` | Mandar tarefa para outra pessoa ou função | Fase 2 |
| `tarefas.ver_todas` | Ver tarefas de todos, não só as próprias | Fase 2 |
| `calendario.gerenciar` | Marcar e remarcar reuniões | Fase 3 |
| `trilhas.gerenciar` | Editar o modelo da trilha | Fase 4 |
| `cofre.ver_senhas` | Ver senhas dos clientes | Fase 5 |
| `contratos.gerenciar` | Gerar e enviar contratos | Fase 6 |
| `mapa.editar` | Editar o mapa mental | Fase 8 |

"Vê todos os clientes / só os que atende" **não** é permissão de função: é uma
chave **do membro** (decisão D3 do mapa), porque duas pessoas com a mesma função
podem ter alcances diferentes.

### Funções que nascem prontas

Roteirista, Videomaker, Editor, Designer, Social media, Gestor de tráfego e
Programador — todas com `tarefas.criar` e mais nada. O dono ajusta depois. Funções
podem ser criadas, renomeadas, recoloridas e desativadas; nunca apagadas (uma
tarefa antiga continua apontando para a função).

## Dados

Migration nova + apêndice idempotente no `baseline.sql` (doutrina de migrations).

```sql
-- Função da equipe (Editor, Videomaker…). Da instalação: sem organization_id.
create table if not exists public.agencia_funcoes (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  cor         text not null default '#64748b',
  permissoes  text[] not null default '{}',   -- só itens do vocabulário (validado no Zod; sem CHECK, ver abaixo)
  ativa       boolean not null default true,
  ordem       int not null default 0,
  criada_em   timestamptz not null default now(),
  unique (nome)
);

create table if not exists public.agencia_membros (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid unique references auth.users(id) on delete set null, -- nulo até aceitar o convite
  nome                text not null,
  whatsapp            text not null,           -- E.164, normalizado
  email               text not null,
  ve_todos_clientes   boolean not null default false,
  situacao            text not null default 'convidado'
                      check (situacao in ('convidado','ativo','desativado')),
  convidado_em        timestamptz not null default now(),
  ativado_em          timestamptz,
  desativado_em       timestamptz,
  unique (email)
);

create table if not exists public.agencia_membros_funcoes (
  membro_id  uuid not null references public.agencia_membros(id) on delete cascade,
  funcao_id  uuid not null references public.agencia_funcoes(id),
  primary key (membro_id, funcao_id)
);

create table if not exists public.agencia_convites (
  id          uuid primary key default gen_random_uuid(),
  membro_id   uuid not null references public.agencia_membros(id) on delete cascade,
  token_hash  text not null unique,            -- SHA-256; o token em claro só existe no link
  expira_em   timestamptz not null,            -- 7 dias
  aceito_em   timestamptz,
  revogado_em timestamptz,
  criado_por  uuid references auth.users(id)
);
```

**Acesso no banco (como ficou na migration 9003).** RLS ligada em todas as tabelas
`agencia_*` e `revoke all` explícito de `anon` e `authenticated`. A única porta do
navegador é `agencia_avisos`: o membro lê e marca como lido só os próprios avisos,
pela função `fn_agencia_membro_atual()` (`security definer`, sem `execute` para
`public`/`anon`). Permissões e linha do membro são lidas no servidor
(`lib/agencia/acesso.ts`), com o client de serviço filtrado pelo `user.id` que o
`getUser()` validou. `permissoes` não tem CHECK: o vocabulário mora em
`lib/agencia/permissoes.ts`, e item desconhecido é ignorado, nunca concedido.

## Como funciona

**Guarda da área** — `requireMembroDaAgencia()` em `lib/agencia/acesso.ts`, mesmo
desenho de `requirePlatformAdmin()`:

1. `getUser()` (nunca `getSession()`). Sem usuário → `/login?next=/agencia`.
2. Módulo desligado → `notFound()`.
3. Platform admin `full` → todas as permissões.
4. Senão, `agencia_membros` com `situacao = 'ativo'` e as funções ativas → permissões somadas.
   Sem linha ativa → `/agencia/sem-acesso`.

E o par de escrita, `exigirPermissao('equipe.gerenciar')`, chamado no começo de toda
server action, que **lança** em vez de redirecionar.

**Convite**

1. Dono preenche nome, WhatsApp, e-mail, funções e a chave de clientes.
2. O sistema cria o membro (`convidado`) e um convite com token aleatório de 32 bytes,
   guardando só o hash.
3. Envia pelo WhatsApp da agência: *"Olá, {nome}! Você foi convidado para a área da
   agência Em Movimento. Crie sua senha: {link}"*. Sem WhatsApp configurado, a tela
   mostra o link para copiar.
4. `/agencia/convite/[token]`: confere hash, validade e revogação. Quem não tem conta
   cria a senha ali; quem já tem entra com ela. O e-mail da conta tem de ser o do convite.
5. Vínculo gravado (`user_id`, `ativo`, `ativado_em`), convite fechado (`aceito_em`),
   auditoria, e a pessoa cai em `/agencia`.

**Login sem `next`.** Membro ativo que não pertence a nenhuma organização cai em
`/agencia`, não no onboarding de organização.

**Desativar.** `situacao = 'desativado'`; o guarda recusa na próxima requisição. Nada
é apagado.

## Telas

| Rota | Quem vê | Conteúdo |
|---|---|---|
| `/agencia` | todo membro ativo | Início: saudação, sininho, atalhos para o que a fase liberar. Nesta fase, quase vazio de propósito. |
| `/agencia/equipe` | `equipe.gerenciar` | Lista de membros (nome, funções como etiquetas coloridas, situação), botão "Convidar", reenviar/revogar convite, desativar/reativar. |
| `/agencia/equipe/funcoes` | `equipe.gerenciar` | Funções com cor e caixas de permissão. |
| `/agencia/configuracoes` | `configuracoes.gerenciar` | WhatsApp da agência e avisos (specs irmãs). |
| `/agencia/convite/[token]` | público (com token) | Criar senha / entrar. Entra em `lib/auth/public-paths.ts`. |
| `/agencia/sem-acesso` | qualquer logado | "Seu acesso à área da agência não está ativo." |

Casca própria, responsiva: menu lateral no computador, barra inferior no celular
(mesmo padrão de `components/shell/BarraInferior.tsx`). Entrada "Agência" no menu do
admin (`components/admin/AdminSidebar.tsx`, com `modulo: "agencia"`).

## Auditoria

`api_audit_log` (com `organization_id` nulo, como as ações de admin):
`agencia.modulo_alterado`, `agencia.membro_convidado`, `agencia.convite_reenviado`,
`agencia.convite_revogado`, `agencia.membro_ativado`, `agencia.membro_alterado`,
`agencia.membro_desativado`, `agencia.funcao_criada`, `agencia.funcao_alterada`.

## Comandos

```bash
pnpm typecheck
pnpm lint
pnpm test:unit > "$SCRATCH/vt.log" 2>&1; echo "exit=$?"     # a suíte inteira, sem caminho
pnpm test:db tests/invariants/agencia-acesso.test.ts           # RLS e funções expostas
pnpm test:db                                                   # antes do PR: baseline install + update
pnpm playwright test tests/e2e/agencia-equipe.spec.ts
pnpm checar:colisao-de-migration
```

## Estrutura

```
app/agencia/                       → casca e telas da área (layout com o guarda)
app/agencia/convite/[token]/       → aceite do convite (rota pública)
app/actions/agencia/               → server actions (todas começam por exigirPermissao)
lib/agencia/acesso.ts              → requireMembroDaAgencia, exigirPermissao
lib/agencia/permissoes.ts          → vocabulário fixo + tipos
lib/agencia/convite.ts             → gerar/verificar token, aceitar
components/agencia/                → componentes da área
supabase/migrations/<ts>_<NNNN>_agencia_equipe.sql
supabase/baseline.sql              → apêndice "-- ---- agência: equipe (migration NNNN) ----"
tests/unit/agencia-*.test.ts
tests/invariants/agencia-acesso.test.ts
tests/e2e/agencia-equipe.spec.ts
evidence/agencia-fase-1/           → screenshots da prova pela tela
```

## Estilo

Nomes e comentários em português, como o resto de `lib/`. Guardas devolvem contexto
tipado; recusa de escrita **lança** um erro nomeado:

```ts
export async function exigirPermissao(p: PermissaoDaAgencia): Promise<ContextoDaAgencia> {
  const ctx = await contextoDaAgencia();          // getUser() + linha do membro
  if (!ctx) throw new AcessoDaAgenciaNegado("sem_acesso");
  if (!ctx.permissoes.has(p)) throw new AcessoDaAgenciaNegado("sem_permissao", p);
  return ctx;
}
```

## Testes

- **Unit:** soma de permissões de várias funções; função desativada não conta;
  platform admin `full` tem tudo e `support_readonly` não tem nada; token expirado,
  revogado ou já aceito é recusado; e-mail diferente do convite é recusado;
  normalização do WhatsApp.
- **Invariante (`test:db`):** `anon` não lê nem escreve nenhuma `agencia_*`;
  `authenticated` comum (dono de tenant que não é da agência) não lê nenhuma linha;
  funções novas sem `execute` para `public`/`anon`; apêndice do baseline aplica em
  install (`ON_ERROR_STOP=1`) e reaplica em update.
- **E2E (pela tela, banco fresco do `baseline.sql` + `bootstrap-owner.ts`):** dono liga
  o módulo → convida → abre o link numa sessão nova → cria senha → cai em `/agencia` →
  tenta `/admin` e é barrado → dono desativa → a sessão do membro perde o acesso.
  Em 375 px e 1280 px, com screenshots em `evidence/agencia-fase-1/`.
- **Cercas existentes que esta fase precisa manter verdes:** `admin-escrita-exige-scope-full`,
  `admin-navegacao-completude`, `navegacao-completude`, `branding` (nada de "Em Movimento"
  escrito no código: o nome sai da marca resolvida).

## Limites

- **Sempre:** guarda no layout **e** na action; Zod em todo input; auditoria em toda mutação.
- **Perguntar antes:** qualquer mudança em `proxy.ts` além de reconhecer `/agencia`;
  mexer no fluxo de convite das organizações (`team_invites`) — o da agência é separado.
- **Nunca:** membro da agência virar linha de `platform_admins`; token de convite em
  claro no banco ou em log; texto com a marca da agência escrito no código.

## Critérios de aceite

1. Com o módulo desligado, `/agencia` responde 404 e o menu do admin não mostra "Agência".
2. Ligado, o dono vê "Agência" no menu do admin e entra em `/agencia` com todas as permissões.
3. Convidar um membro com duas funções grava o membro, as duas funções e um convite, e
   manda o link pelo WhatsApp da agência (ou mostra o link, se não houver WhatsApp).
4. O link aceita uma vez, expira em 7 dias e para de valer quando revogado.
5. O membro aceito cai em `/agencia`; `/admin/*` o leva para `/admin/forbidden`;
   `/app` não o manda para o onboarding de organização.
6. Membro sem `equipe.gerenciar` não vê `/agencia/equipe` e a action correspondente
   recusa mesmo chamada direto.
7. Desativar tira o acesso na requisição seguinte; reativar devolve.
8. Toda mutação deixa uma linha em `api_audit_log`.
9. Todas as telas funcionam em 375 px sem rolagem horizontal.

## Respostas (23/10/2026)

- **E1/E2** — Confirmado. O painel admin é o centro com duas portas, "Agência" e
  "Organizações" (mapa, D15). A equipe entra pelo login normal e cai em `/agencia`.
- **E4** — Confirmado: convite pelo WhatsApp da agência, link copiável como reserva.
- **Verificação em duas etapas** — Não. Só login e senha para a equipe.
