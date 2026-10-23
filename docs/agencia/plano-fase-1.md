# Plano de implementação — Fase 1 (equipe, WhatsApp da agência, avisos)

> Estado: **construída e publicada no teste.emmovimento.tech** (23/10/2026), branch
> `feat/agencia-fase-1`, ainda sem commit. Prova pela tela em `evidence/agencia-fase-1/`.
>
> **Resultado da verificação (23/10/2026):**
> - typecheck limpo; testes da agência 53/53; regras de acesso no Postgres 21/21;
>   baseline install + update sem erro (Postgres descartável na VPS).
> - Suíte unit inteira e invariantes têm falhas **anteriores** ao fork (Bling,
>   Insights sociais, migration 0654 duplicada, caminhos do Windows) — nenhuma cita a agência.
> - Exceção registrada: `app/agencia` e `components/agencia` em `FORA_DO_PRODUTO` do
>   teste de espanhol (área só da equipe brasileira).
> - Achado na prova: o sininho lia `agencia_avisos` pelo client do navegador e
>   recebia 401 (cookie HttpOnly); passou a ler por server action.
> - **Não provado ainda:** envio real pelo WhatsApp (número da agência não conectado),
>   perfil do dono com WhatsApp (dado pessoal, fica com o dono) e o spec Playwright
>   `tests/e2e/agencia-equipe.spec.ts` (a prova foi feita por script na VPS).
> Specs aprovadas: [`SPEC-equipe`](SPEC-equipe.md), [`SPEC-whatsapp-agencia`](SPEC-whatsapp-agencia.md),
> [`SPEC-avisos`](SPEC-avisos.md). Índice: [mapa de capacidades](mapa-de-capacidades.md).
>
> Este plano mora aqui, e não em `tasks/`, porque `tasks/todo.md` tem 13 itens abertos de
> outro trabalho e não pode ser sobrescrito.

## Visão geral

Ao final, o dono liga o módulo, cadastra a equipe, cada pessoa recebe o convite no
WhatsApp, cria a senha, entra em `/agencia` (celular ou computador) e recebe avisos
no sininho e no WhatsApp. Nove tarefas, em três blocos, com uma parada de conferência
entre eles.

## Decisões de arquitetura

- **Liga/desliga como a Cobrança:** chave `MODULO_AGENCIA` em `platform_config`,
  entrada em `MODULOS_OPCIONAIS` e `MODULOS_SO_DA_INSTALACAO` (`lib/instalacao/modulos.ts`).
  As tabelas existem vazias em todo banco.
- **Uma migration para a fase inteira**, numerada na faixa do fork:
  `supabase/migrations/<timestamp>_9003_agencia_equipe_e_avisos.sql` (o fork usa 9001 e
  9002 para as suas; a faixa evita colisão com o projeto original). Mais o apêndice
  idempotente no fim do `baseline.sql`.
- **Escrita por server action** em `app/actions/agencia/`, cada uma começando por
  `exigirPermissao(...)`. Nenhuma rota nova em `app/api/v1` nesta fase.
- **Envio de WhatsApp reaproveita** `criarTransporteDoAviso` e `criarPacingDoCanal`
  do aviso de suporte, por um handler novo do `event_log` registrado em
  `lib/event-log/register-handlers.ts`.
- **Consequência para publicar:** handler novo roda no `worker`, então publicar exige
  reconstruir **app e worker** com o código do fork e reaplicar o `baseline.sql`.

## Antes de começar

| # | O quê | Quem |
|---|---|---|
| P1 | **Onde construir.** A branch atual (`feat/automacoes-manychat`) tem 42 arquivos alterados de outro trabalho. Proposta: um worktree novo, `feat/agencia-fase-1`, saindo do último commit dessa branch, para não misturar nada. | Dono decide |
| P2 | **Docker ligado** nesta máquina (está instalado, mas parado). Sem ele não rodam o `test:db`, o Supabase local nem o WAHA local da prova pela tela. | Dono liga |
| P3 | **Organização da agência + número conectado por QR Code** na central. Só é preciso para o teste real no teste.emmovimento.tech; em desenvolvimento usa-se o WAHA local. | Dono, antes da Tarefa 7 ir para o ambiente de teste |

## Tarefas

### Bloco A — Porta e chaves

#### Tarefa 1: Módulo "Agência" com porta no admin e área vazia
**Descrição:** liga/desliga do módulo, entrada "Agência" no menu do admin, casca
responsiva de `/agencia` (menu lateral / barra inferior) e guarda que, por enquanto,
só deixa entrar platform admin `full`.
**Aceite:**
- [ ] Módulo desligado: `/agencia` → 404 e o menu do admin não mostra "Agência".
- [ ] Ligado: o dono vê a entrada e abre `/agencia` com a casca.
- [ ] Quem não é platform admin `full` vai para `/agencia/sem-acesso`.
**Verificação:** `pnpm vitest run tests/unit/agencia-modulo.test.ts`; cercas `admin-navegacao-completude` e `branding` verdes; conferência no navegador em 375 px e 1280 px.
**Depende de:** nada · **Arquivos:** `lib/instalacao/modulos.ts`, `components/admin/AdminSidebar.tsx`, `app/agencia/layout.tsx`, `app/agencia/page.tsx`, `components/agencia/CascaDaAgencia.tsx` · **Tamanho:** M

#### Tarefa 2: Tabelas da fase, regras de acesso e funções iniciais
**Descrição:** migration 9003 com as sete tabelas das três specs, `fn_agencia_membro_atual()`,
RLS, as sete funções iniciais, e o mesmo bloco no apêndice do `baseline.sql`.
**Aceite:**
- [ ] `anon` não lê nem escreve nenhuma `agencia_*`; usuário de tenant comum não lê nenhuma linha.
- [ ] Funções novas sem `execute` para `public` e `anon`.
- [ ] Baseline aplica em install (`ON_ERROR_STOP=1`) e reaplica em update sem erro.
**Verificação:** `pnpm test:db tests/invariants/agencia-acesso.test.ts`; `pnpm test:db`; `pnpm checar:colisao-de-migration`.
**Depende de:** nada · **Arquivos:** a migration, `supabase/baseline.sql`, `tests/invariants/agencia-acesso.test.ts`, `lib/database.types.ts` · **Tamanho:** M

#### Tarefa 3: Guarda de membros, soma de permissões e login que cai na área
**Descrição:** `requireMembroDaAgencia()` e `exigirPermissao()` lendo as tabelas;
vocabulário de permissões; membro ativo sem organização que entra sem `next` cai em
`/agencia`.
**Aceite:**
- [ ] Permissões = soma das funções ativas; função desativada não conta; `full` tem tudo; `support_readonly` não entra.
- [ ] Membro desativado perde o acesso na requisição seguinte.
- [ ] Membro sem organização não é mandado ao onboarding de organização.
**Verificação:** `pnpm vitest run tests/unit/agencia-acesso.test.ts`.
**Depende de:** 1, 2 · **Arquivos:** `lib/agencia/acesso.ts`, `lib/agencia/permissoes.ts`, `app/agencia/sem-acesso/page.tsx`, ponto de redirecionamento pós-login · **Tamanho:** M

**🔎 Parada A:** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (a suíte inteira, exit code como autoridade), `pnpm test:db`. Mostro a área vazia funcionando.

### Bloco B — Equipe

#### Tarefa 4: Funções da equipe (criar, editar, cor, permissões)
**Aceite:**
- [ ] Criar, renomear, recolorir e desativar função; nunca apagar.
- [ ] Marcar e desmarcar permissões do vocabulário; valor fora do vocabulário é recusado no servidor.
- [ ] Cada mudança gera linha em `api_audit_log`.
**Verificação:** unit das actions; conferência na tela.
**Depende de:** 3 · **Arquivos:** `app/agencia/equipe/funcoes/page.tsx`, `app/actions/agencia/funcoes.ts`, `components/agencia/EditorDeFuncao.tsx`, teste · **Tamanho:** M

#### Tarefa 5: Membros (cadastrar, várias funções, alcance de clientes, desativar)
**Aceite:**
- [ ] Cadastrar com nome, WhatsApp, e-mail, uma ou mais funções e a chave "todos os clientes / só os meus"; gera convite e mostra o link para copiar.
- [ ] Reenviar e revogar convite; desativar e reativar membro.
- [ ] Quem não tem `equipe.gerenciar` não vê a tela e a action recusa chamada direto.
**Verificação:** unit das actions e da normalização do WhatsApp; conferência na tela.
**Depende de:** 4 · **Arquivos:** `app/agencia/equipe/page.tsx`, `app/actions/agencia/membros.ts`, `lib/agencia/convite.ts`, `components/agencia/FormularioDeMembro.tsx`, teste · **Tamanho:** M

#### Tarefa 6: Aceite do convite
**Aceite:**
- [ ] `/agencia/convite/[token]` cria a senha (conta nova) ou pede login (conta existente), exige o e-mail do convite e leva para `/agencia`.
- [ ] Token vale uma vez, expira em 7 dias e para de valer quando revogado.
- [ ] O dono recebe o aviso `convite_aceito` (aparece quando a Tarefa 9 existir; até lá, só auditoria).
**Verificação:** unit do token; e2e `tests/e2e/agencia-equipe.spec.ts` (convidar → abrir em sessão nova → criar senha → cair em `/agencia` → `/admin` barrado → desativar → acesso perdido).
**Depende de:** 5 · **Arquivos:** `app/agencia/convite/[token]/page.tsx`, `app/actions/agencia/aceitarConvite.ts`, `lib/auth/public-paths.ts`, e2e · **Tamanho:** M

**🔎 Parada B:** suíte inteira + o e2e da equipe com screenshots em `evidence/agencia-fase-1/`. Mostro o fluxo completo de convite **sem** WhatsApp.

### Bloco C — WhatsApp e avisos

#### Tarefa 7: WhatsApp da agência (configurar, enfileirar, entregar, testar)
**Aceite:**
- [ ] Escolher o canal entre os conectados e salvar janela de horário (padrão 7h–22h).
- [ ] Mensagem de teste chega pelo WAHA local; fora da janela espera; pacing respeitado.
- [ ] Sem configuração, eventos terminam `skipped`, nunca `error`.
**Verificação:** unit do handler com relógio, banco e transporte falsos; prova real com WAHA local.
**Depende de:** 3 · **Arquivos:** `lib/agencia/whatsapp/enfileirar.ts`, `lib/agencia/whatsapp/handler.ts`, `lib/event-log/register-handlers.ts`, `app/agencia/configuracoes/page.tsx`, `app/actions/agencia/whatsapp.ts` · **Tamanho:** M

#### Tarefa 8: Convite enviado pelo WhatsApp
**Aceite:**
- [ ] Convidar e reenviar mandam o link pelo WhatsApp da agência, com o nome da marca resolvida (nada escrito no código).
- [ ] Sem WhatsApp configurado, continua o link para copiar.
**Verificação:** unit; e2e da equipe estendido.
**Depende de:** 5, 7 · **Arquivos:** `app/actions/agencia/membros.ts`, `lib/agencia/convite.ts`, teste · **Tamanho:** S

#### Tarefa 9: Avisos (motor, sininho, perfil, antecedência, teste)
**Aceite:**
- [ ] `criarAviso` grava no sininho e, se o membro aceita, enfileira o WhatsApp; avisos iguais em 10 min viram uma mensagem.
- [ ] Sininho atualiza sem recarregar; membro nunca vê aviso de outro (provado no banco).
- [ ] Perfil liga/desliga o WhatsApp; configurações salvam a antecedência (1–7 dias); `destinatariosDoAviso()` resolve responsáveis e `avisos.gerais`.
**Verificação:** unit (agrupamento, destinatários, antecedência); invariante de RLS; e2e: aviso de teste chega no sininho e no WhatsApp; com WhatsApp desligado, só no sininho.
**Depende de:** 7 · **Arquivos:** `lib/agencia/avisos/{criar,destinatarios,tipos}.ts`, `components/agencia/Sininho.tsx`, `app/agencia/perfil/page.tsx`, `app/actions/agencia/avisos.ts`, testes · **Tamanho:** M (se passar de 5 arquivos de código, divido em motor + telas)

**🔎 Parada C — fase pronta:**
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (exit 0), `pnpm test:db`, `pnpm build`.
- [ ] Prova pela tela num banco fresco (`baseline.sql` + `bootstrap-owner.ts`), sem envs opcionais, em 375 px e 1280 px, com evidência em `evidence/agencia-fase-1/`.
- [ ] Todos os critérios de aceite das três specs conferidos um a um.
- [ ] Você revisa antes de qualquer commit ou publicação.

## Ordem e paralelismo

```
1 ─┐
   ├─ 3 ─┬─ 4 ─ 5 ─ 6 ─┐
2 ─┘     │             ├─ 8
         └─ 7 ─────────┤
                       └─ 9
```

1 e 2 são independentes; 7 pode andar junto com 4–6. Como as tarefas tocam arquivos
vizinhos (casca, actions), sigo em sequência numa sessão só.

## Riscos

| Risco | Impacto | Como lidar |
|---|---|---|
| Publicar só o app e esquecer o worker | Alto: os avisos não saem | Checklist de publicação: reconstruir app **e** worker, reaplicar `baseline.sql` (memória do fork) |
| Ponto de redirecionamento pós-login mal escolhido manda dono de tenant para `/agencia` | Médio | Regra só vale para quem é membro ativo **e** não tem organização; teste cobre o dono de tenant |
| Cercas existentes reprovarem a área nova | Baixo | Rodar a suíte inteira em cada parada, não só os testes novos |
| WAHA local indisponível no Windows | Médio para a prova | Docker ligado (P2); senão, a prova real do WhatsApp vai para o ambiente de teste |

## Perguntas

- **P1** — Construir num worktree novo `feat/agencia-fase-1` a partir do último commit da branch atual?
- **P2** — Consegue ligar o Docker Desktop nesta máquina?
