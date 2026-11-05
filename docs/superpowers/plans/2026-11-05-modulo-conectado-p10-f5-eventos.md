# Módulo conectado — F5: eventos que o módulo busca — Plano de implementação

> **Para quem executa:** um subagente por tarefa, na ordem. Quem codifica não valida: o diff é lido por outra pessoa e o CI do GitHub é o juiz (nada de pnpm, vitest ou Docker local). A Tarefa 1 é de banco e segurança: Sonnet.

**Meta:** o módulo conectado fica sabendo, buscando por cursor, de três fatos que o obrigam a agir: *contato anonimizado*, *módulo desativado na organização* e *organização suspensa*. A LGPD não pode ficar presa: um módulo desativado continua lendo por 30 dias.

**Arquitetura:** três gatilhos de banco escrevem numa tabela só de eventos (gatilho nunca faz HTTP). Uma rota `GET` devolve os eventos da organização por cursor opaco. O módulo prova quem é com a **mesma assinatura HMAC** da busca de token (F2), então a leitura vale mesmo depois de o token ter sido revogado. A instalação vê em `/admin/extensoes` o último cursor lido e o atraso.

**Stack:** Postgres (migration em tripla), Next.js route handler, Zod, cursor HMAC já existente em `lib/api/`.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, seção F5 e decisão 4. Depende de F2 (`lib/extensions/token-do-modulo.ts`, `segredo-do-modulo.ts`).

## Decisões deste plano (o mantenedor pode trocá-las na revisão do PR)

- **D1 — a leitura é assinada, não por bearer.** A spec diz "com o token do módulo" e propõe, para a LGPD, "um token que só lê esta rota por 30 dias depois da revogação". Um token revogado não autentica; criar um segundo tipo de token só para isso mexeria em `api_tokens`, no teto de 50 e em todas as portas. A assinatura HMAC já existe, já tem nonce e janela de 5 min, e prova o mesmo (quem tem o segredo da instalação). Efeito para o módulo: os mesmos cinco cabeçalhos `X-Module-*` da busca de token.
- **D2 — quem pode ler.** Vínculo `enabled` da organização com a instalação, **ou** existe evento `module_disabled` daquele par nos últimos 30 dias (e nenhuma reativação depois dele). Organização suspensa continua lendo: o evento de suspensão precisa chegar.
- **D3 — eventos são da organização.** Cada linha leva `organization_id`; `contact_anonymized` e `organization_suspended` valem para qualquer módulo da organização; `module_disabled` leva `installation_id` e só o par certo o lê. O corpo do evento leva só identificadores.
- **D4 — `organization_suspended` também sai quando o status vira `redacted`** (a LGPD apaga a organização; o módulo precisa saber). Declarado aqui porque a spec lista só "suspensa".
- **D5 — sem expurgo nesta fase.** A linha tem ~100 bytes e só identificadores. Dívida declarada: expurgo por idade (mínimo 1 ano) fica para quando houver medição de volume; o cursor atrasado do módulo nunca perde evento por causa de expurgo curto.

## Medido antes de escrever (05/11, F4 em `5ece80de9`)

- Anonimização de contato: `fn_lgpd_anonymize_contact` (migrations 0229 a 0747) faz `update contacts set is_anonymized = true`. Já existe gatilho `trg_lgpd_secoes_de_modulo` (`after update of is_anonymized ... when (new.is_anonymized and not old.is_anonymized)`) — o mesmo molde serve.
- `organizations.status` tem CHECK `active|suspended|redacted|archived`; `fn_org_operante(p_org)` define operante.
- Cursor opaco HMAC já existe em `lib/api/` (CLAUDE.md: "cursor opaco HMAC"); a Tarefa 2 localiza o helper e o reutiliza.
- A busca de token (`emitirTokenDoModulo`) já faz formato → carimbo → segredo → assinatura → nonce; a leitura de eventos reutiliza esses passos sem copiá-los (Tarefa 2).

## Restrições globais

- Gatilho de banco nunca faz HTTP. Função nova em `public`: `revoke execute ... from public, anon, authenticated` e `grant` só a `service_role`.
- Toda leitura filtra `organization_id` da LINHA do vínculo/instalação, nunca do cliente; o módulo nunca escolhe a organização além de assiná-la (o HMAC cobre a organização).
- Todas as recusas de autenticação devolvem a mesma resposta genérica (como a busca de token). Falha nossa é 5xx.
- Migration: NNNN por `pnpm checar:colisao-de-migration` (esperado 9120; confira), psql puro, idempotente, `-- manifest:`, apêndice no `supabase/baseline.sql` antes do bloco "VARREDURA anon (0116)", e nos testes de invariante a sabotagem prevista.
- Textos novos com `t()` literal em es/en/tr; `noUncheckedIndexedAccess`; catraca de marca reprova 'deskcomm' hardcoded; embed do PostgREST sempre com FK explícita.
- Um commit por tarefa, em português, sem linha de atribuição.

## Foco da revisão

1. Módulo atrasado 40 dias que volta: lê tudo desde o cursor, sem perda.
2. Evento de organização B nunca aparece para o módulo da organização A (mesmo módulo instalado nas duas).
3. Módulo desativado há 31 dias: recusado (mesma resposta genérica). Reativado: volta a ler.
4. Cursor adulterado, de outra organização ou de outra instalação: recusado como inválido, nunca lê a partir de posição escolhida pelo módulo.
5. Mesmo contato anonimizado duas vezes: um só evento.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261105130000_9120_modulo_conectado_eventos.sql` + apêndice no baseline | tabela de eventos, tabela de cursores, 4 gatilhos, funções de leitura e de autorização |
| `lib/extensions/prova-do-modulo.ts` | os passos de prova (formato, carimbo, segredo, assinatura, nonce) extraídos de `token-do-modulo.ts`, usados pela busca de token e pela leitura de eventos |
| `lib/extensions/eventos-do-modulo.ts` | autoriza, lê por cursor, grava o cursor |
| `app/api/v1/extensions/events/route.ts` | a rota `GET` |
| `lib/auth/public-paths.ts` | caminho exato `/api/v1/extensions/events` (mesma regra da rota de token) |
| `/admin/extensoes` (componente existente) | último cursor, quando, atraso |

---

### Tarefa 1: banco

**Files:** Create a migration e o apêndice; Create `tests/invariants/extensoes-eventos.test.ts`.

**Interfaces — Produces (SQL):**
- `public.extension_module_events(id bigint generated always as identity primary key, organization_id uuid not null references organizations(id) on delete cascade, kind text not null check (kind in ('contact_anonymized','module_disabled','organization_suspended')), subject_id uuid null, installation_id uuid null, occurred_at timestamptz not null default now())`, RLS ligada **sem policy** (só service_role), índice `(organization_id, id)`. `check` de coerência: `contact_anonymized` exige `subject_id`; `module_disabled` exige `installation_id`.
- `public.extension_module_cursors(installation_id uuid references extension_installations(id) on delete cascade, organization_id uuid references organizations(id) on delete cascade, last_event_id bigint not null default 0, last_read_at timestamptz not null default now(), primary key (installation_id, organization_id))`, RLS ligada sem policy.
- Gatilhos: (a) `after update of is_anonymized on contacts when (new.is_anonymized and not old.is_anonymized)` ⇒ `contact_anonymized` (`subject_id = new.id`); (b) `after update of enabled or delete on organization_extensions` quando passa de `enabled` a não ligado, ou apaga linha ligada ⇒ `module_disabled`; (c) `after update of disabled_at, removed_at on extension_installations` quando passa de nulo a não nulo ⇒ um `module_disabled` por vínculo ligado da instalação; (d) `after update of status on organizations when (new.status in ('suspended','redacted') and old.status is distinct from new.status)` ⇒ `organization_suspended`. Evento duplicado do mesmo fato não pode nascer (índice único parcial ou `on conflict do nothing` sobre `(kind, organization_id, coalesce(subject_id, installation_id))` nos fatos únicos).
- `fn_extensions_events_allowed(p_organization uuid, p_installation uuid) returns boolean` (regra D2) e `fn_extensions_events_read(p_organization uuid, p_installation uuid, p_after bigint, p_limit int) returns jsonb` (`{events:[{id,kind,subject_id,installation_id,occurred_at}], last_id, has_more}`; `p_limit` limitado a 100 dentro da função; só eventos da organização, `module_disabled` só do par) e `fn_extensions_events_ack(p_organization, p_installation, p_event_id)` (upsert do cursor; nunca regride). Todas `security invoker`, `search_path = ''`, `grant` só a `service_role`.

- [ ] Testes de invariante (Postgres real): cada gatilho gera exatamente um evento; anonimizar duas vezes gera um; evento da organização B não aparece na leitura da A; módulo desativado há 29 dias lê, há 31 dias não (use `occurred_at` fixado); reativar volta a permitir; organização suspensa continua permitida; cursor não regride; `limit` acima de 100 é cortado; `anon`/`authenticated` não executam as funções nem leem as tabelas.
- [ ] Sabotagem prevista para cada gatilho: remover o gatilho deixa o teste vermelho.

### Tarefa 2: leitura assinada e rota

**Files:** Create `lib/extensions/prova-do-modulo.ts`, `lib/extensions/eventos-do-modulo.ts`, `app/api/v1/extensions/events/route.ts` e testes; Modify `lib/extensions/token-do-modulo.ts` (passa a usar a prova extraída; comportamento e testes atuais inalterados), `lib/auth/public-paths.ts`.

**Interfaces:**
- Produces: `provarModulo(entrada: CabecalhosDaBusca, agoraMs?: number): Promise<{ok:true}|{ok:false;motivo:"recusado"|"indisponivel"}>` (carimbo → segredo → assinatura → nonce, exatamente a ordem atual); `lerEventosDoModulo(entrada, cursor: string | null, limite: number, requestId: string)` e o cursor opaco HMAC (helper do repositório; liga `organization_id`, `installation_id` e a posição).
- Resposta: `{ events: [...], next_cursor: string | null, has_more: boolean }`, `Cache-Control: no-store`.

- [ ] Testes primeiro: assinatura inválida, carimbo fora da janela, nonce repetido, instalação sem segredo, módulo desativado há mais de 30 dias e organização sem vínculo ⇒ **a mesma** resposta genérica 401; erro de banco ⇒ 503; cursor de outra organização/instalação, adulterado ou ausente de assinatura ⇒ 400 `invalid_cursor` (a única resposta que distingue, e só depois da autenticação); `limit` fora de 1..100 ⇒ 400; pagina por cursor sem repetir nem pular; atualiza o cursor lido só ao receber o cursor seguinte (o cursor recebido é o reconhecimento do anterior).
- [ ] Rate limit na rota (padrão da rota de token); sem `Idempotency-Key` (GET).
- [ ] A rota não audita (leitura) e não exige `requireSupportWrite(` (só POST/PUT/PATCH/DELETE; confira a cerca `suporte-cobertura-de-efeitos`).
- [ ] Teste de regressão: a busca de token continua passando em todos os casos de `token-do-modulo.test.ts` sem alteração de asserções.

### Tarefa 3: `/admin/extensoes` mostra o atraso

**Files:** Modify o componente da lista de instalações e a rota/serviço que o alimenta (ache em `components/extensions/` e `lib/extensions/service.ts`); testes.

- [ ] Para cada instalação `connected`: por organização com vínculo, último cursor lido, quando (`last_read_at`) e atraso (eventos com `id` maior que o cursor). Selo "atrasado" quando há atraso e a última leitura é mais antiga que 24 h, ou nunca leu e há evento com mais de 24 h. Texto em português simples explicando o que significa para a LGPD ("este módulo ainda não apagou os dados de N contatos anonimizados").
- [ ] Teste: sem módulo conectado a tela não muda; módulo em dia não mostra selo; módulo atrasado mostra selo; a contagem de atraso nunca mistura organizações.

### Tarefa 4: cercas e documentos

**Files:** `tests/unit/eventos-do-modulo-so-por-prova.test.ts`; `docs/testing/user-journey-map.md` (J71); `docs/architecture/extensoes-declarativas.architecture.json` (nós `module_events_table`, `module_events_route`, `module_events_cursor`, ≥2 arestas cada); `evidence/modulo-conectado-f5/declaracoes.md`; `.changes/modulo-conectado-eventos.md`.

- [ ] Cerca: só `eventos-do-modulo.ts` lê `extension_module_events`; a rota está em `public-paths.ts` pelo caminho exato; nenhum gatilho chama `net.http_*`/`pg_net` (varredura da migration).
- [ ] J71 (todos "NÃO EXECUTADO" até haver módulo real) cobrindo o Foco da revisão; declarações com MEDIDO/NÃO MEDIDO, destino núcleo + extensão, Sistema Vivo (alimenta: LGPD, ativação, suspensão; alimenta: o módulo e o admin; laço de retorno: selo "atrasado" muda a decisão de quem administra), e a nota das decisões D1 a D5 para o PR.

## Autoverificação

- Cobertura da spec F5: busca por cursor opaco e só da organização (T2), lista fechada e mínima (T1), só identificadores (T1), LGPD não presa por 30 dias (D2, T1/T2), cursor visível em `/admin/extensoes` (T3).
- Fora de escopo: expurgo (D5); quarto tipo de evento; webhook de entrega (o módulo busca, o host não empurra); F6.
