# Módulo conectado (Spec 33) — índice dos planos

Documento de coordenação. Os planos de implementação são um por fatia. Cada fatia sai num PR próprio ao
`melgarafael/DeskcommCRM` e entrega software que funciona sozinho.

**Spec:** `docs/specs/33-spec-modulo-conectado.md` (PROPOSTA 0.2.0). Ela vai **dentro do PR da fatia 1**,
não sozinha antes, e traz as 9 decisões onde a ADR-0005 não decide. O mantenedor troca qualquer uma na
revisão do PR em que ela aparece. Nenhuma fatia espera resposta para começar.

> Estes planos são arquivos de trabalho do fork. Eles falam de regras locais: nada roda na máquina de quem
> implementa, e o veredito é o CI do fork. Se algum dia um deles for a um PR do upstream, retirar essas
> regras antes. O desenho privado de uso (imagem na VPS, assistente por último) fica fora deste repositório.

## A ordem (e por quê)

| # | Fatia | Plano | Depende de | Toca schema? | Toca tela? |
|---|---|---|---|---|---|
| 1 | **R0**: rota com `resolveAuthDual` tem porta no proxy; as 3 rotas barradas ganham a porta; a Spec 33 entra junto | `2026-11-03-modulo-conectado-p1-r0-porta-do-proxy.md` ✅ escrito | — | não | não |
| 2 | **R1**: configuração, 111 rotas (158 métodos), 12 PRs | `2026-11-03-modulo-conectado-p2-r1-configuracao.md` ✅ escrito | 1 | não | não |
| 3 | **R2**: operação, 122 rotas (171 métodos), 9 PRs | `2026-11-03-modulo-conectado-p3-r2-operacao.md` ✅ escrito | 1 | não | não |
| 4 | **R3**: leitura e análise, 28 rotas (31 métodos), 4 PRs | `2026-11-03-modulo-conectado-p4-r3-leitura-e-analise.md` ✅ escrito | 1 | não | não |
| 5 | **F1**: perfil `connected`, origem do serviço no catálogo, interruptor da instalação | `2026-11-03-modulo-conectado-p5-f1-perfil-connected.md` ✅ escrito (não sobe `HOST_API_VERSION`: ver a decisão no plano) | — | sim | sim (`/admin/extensoes`) |
| 6 | **F2**: segredo da instalação, token do módulo, revogação, ator `module` | escrito quando a F1 estiver provada | 5 | sim | sim (tela de tokens) |
| 7 | **F3**: consentimento por área, papel efetivo, JWT do host | escrito quando a F2 estiver provada | 6 | sim | sim (ativação) |
| 8 | **F4**: `/app/m/[modulo]`, grupo "Módulos", painel, `postMessage` | escrito quando a F3 estiver provada | 7 | não | sim |
| 9 | **F5**: eventos por cursor, inclusive LGPD depois da revogação | escrito quando a F2 estiver provada | 6 | sim | sim (`/admin/extensoes`) |
| 10 | **F6**: contrato congelado de rotas, formatos e áreas | escrito quando a F3 e uma área de R estiverem provadas | 7, 2 | não | não |

**As duas trilhas.** As rotas (1 → 2, 3 e 4 em paralelo) e a plataforma (5 → 6 → 7 e 9 → 8; a 10 fecha
as duas) andam ao mesmo tempo. A F1 não depende da R0; a spec só viaja no PR da R0.

**A receita comum das fatias R** está em `2026-11-03-modulo-conectado-receita-r.md`: as duas receitas de
conversão, o teste por área, o cliente falso por organização (entregue na R0), escopo e papel do token e
quando parar. As tabelas de cada plano R foram medidas em `fe7a11457`; cada tarefa mede de novo a sua área
antes de começar.

**Por que a R0 vem primeiro.** Ela é a cerca de todas as fatias R: sem ela, uma rota convertida pode
aceitar token no handler e continuar recusada pelo proxy, com todos os testes do handler verdes. Hoje já
há 3 rotas assim. E é a menor peça que leva a Spec 33 junto.

**Por que R anda em paralelo com F.** R não depende de F. É o caminho que o mantenedor já aceitou em
17/09 ("converter as rotas que cada integração precisar"), com precedentes mesclados (#661, #2194, #2824).

## O caminho de cada fatia (vale para todas)

1. **Guias antes de escrever:** skills `deskcomm-doutrina` e `deskcomm-contribuir`, e `sistema-vivo` nas
   fatias que criam peça (F1 a F5). O checklist de 10 itens vai no PR, nomeando o artefato concreto.
2. **Medir antes:** `gh pr list --repo melgarafael/DeskcommCRM --state open` com os arquivos da fatia; se
   um PR aberto, de qualquer autor, tocar os mesmos arquivos, parar e ler os dois lados.
3. **Branch limpa:** worktree em `.claude/worktrees/<nome>`, criada de `origin/main` do produto (nunca da
   `main` do fork); hooks do contribuidor armados; `git rev-list --count HEAD..origin/main` = 0.
4. **Quem escreve o código:** o loop de código do `LOOP-AGENTES.md` (pesquisador → coder → tester →
   reviewer cego → juiz). O coder recebe o plano. Todo brief termina com "NÃO rode nenhum teste,
   typecheck nem lint". Decisão de schema, RLS, permissão e segurança fica com a sessão do Claude.
5. **Commits** com a identidade do `git config` deste clone, um por tarefa; nunca `--no-verify`, `reset
   --hard`, `rebase` ou `push --force`.
6. **Veredito = CI do fork:** `git push fork <branch>` e PR interno `--repo paulolimajr77/ThothCRM --base
   base/main-do-rafael`, fechado sem mesclar. Fatias que tocam tela precisam do `e2e`, que só roda em PR
   contra `main`: nesse caso o portão é o PR ao upstream, com o `e2e` dele.
7. **Sabotagem pelo CI:** branch descartável com um commit que desfaz a linha da regra; "N de M" previsto
   antes de rodar; conferir; fechar e apagar.
8. **Pré-voo** (`pre-voo.sh`, `pnpm checar:colisao-de-migration`, `pnpm release:conferir`) antes de cada
   push. Só leem o git.
9. **PR ao `melgarafael/DeskcommCRM`:** o Paulo lê o texto antes. O PR leva: o que muda para quem usa,
   o que foi medido (saídas do CI e sabotagens), o bloco **"O que NÃO medi"** e a assinatura
   `— Paulo Lima Jr`. Nunca cita o assistente nem cliente.
10. **Depois do merge:** `git worktree remove` da pasta, com `git status` limpo.

## Portões

| Portão | Trava | Quem decide |
|---|---|---|
| Texto do PR da fatia 1 dizer ou não que existe um consumidor privado | só o texto do PR da fatia 1 | Paulo (pergunta 3 da spec privada) |
| Fatia com migration | o push | a sessão do Claude, conferindo a tripla e a colisão |
| Teste de 2 organizações vermelho | tudo | ninguém segue até resolver |

## Estado desta entrega (03/11/2026)

- Planos escritos: **fatias 1 a 4** e a receita comum. Nenhum código foi escrito, nenhum comando de teste
  foi executado, nada foi empurrado.
- Faltam os planos das fatias 5 a 10 (F1 a F6).
