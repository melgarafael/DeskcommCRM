# Continuidade — 5 itens a construir na área da agência (para o Antigravity)

> Escrito em 30/10/2026 para outra IA (Antigravity) continuar. São os itens **1, 3, 6, 7 e 8** do
> relatório [`analise-d8-crm.md`](analise-d8-crm.md): ideias vistas no D8-Crm que a nossa área
> da agência ainda não tem e que **não pedem decisão do dono**. Nada aqui foi construído ainda.
>
> **Leia antes, nesta ordem:**
> 1. [`AGENTS.md`](../../AGENTS.md) (raiz) e [`CLAUDE.md`](../../CLAUDE.md) — a doutrina do repositório;
> 2. [`CONTINUIDADE.md`](CONTINUIDADE.md) — o estado do módulo, como publicar e provar no teste, e
>    as lições aprendidas;
> 3. [`plano-ajustes-2026-10-27.md`](plano-ajustes-2026-10-27.md) › Andamento — o que foi feito
>    por último.

---

## 0. Regras que não se quebram (resumo do CONTINUIDADE)

| Regra | Detalhe |
|---|---|
| Onde trabalhar | Worktree `F:\Área de Trabalho\SITES CLIENTES\CRM TESTE\DeskcommCRM-agencia`, branch **`feat/agencia-ajustes`**. O checkout principal (`…\DeskcommCRM`) é de **outro chat**: não mexer nele. |
| Git | **Sem push.** Um commit por item, com a linha `Co-Authored-By` no padrão do `git log`. |
| Produção | **Nunca tocar na central** (`/docker/deskcommcrm` na VPS). Tudo é publicado e provado no **teste** (`teste.emmovimento.tech`, `/docker/deskcommcrm-teste`). |
| Docker | Sem Docker no PC do dono. `test:db` e as provas de tela rodam **na VPS** (`root@82.25.66.240`). |
| Typecheck | `NODE_OPTIONS=--max-old-space-size=7168 npx tsc --noEmit -p tsconfig.typecheck.json` **antes de todo commit e de toda publicação**. |
| Migrations | Próxima livre da agência: **9015**. Arquivo `supabase/migrations/<timestamp>_9015_<slug>.sql` com `-- manifest:` + o mesmo corpo no **apêndice do `supabase/baseline.sql`**, antes da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`. Insira o apêndice **por fatia** (nunca `String.replace` do JS: o `$$` vira `$`). Veja também a colisão de numeração do §6b do CONTINUIDADE. |
| Tabelas da agência | Da **instalação**: sem `organization_id`, RLS ligada, `revoke all … from anon, authenticated`, nenhuma policy. O acesso é só pelo servidor (client admin), **depois** de `exigirPermissao(...)` e de conferir o alcance (`carregarAlcance` / `podeVerCliente`). |
| Ações (server actions) | `"use server"`, envolvidas em `seguro(...)`, validação Zod, `auditarAgencia(...)` nas mutações; código de auditoria novo vai em `lib/audit/actions.ts` (arquivo **compartilhado**: publique como patch). |
| Avisos | Só por `criarAviso` (`lib/agencia/avisos/criar.ts`); tipo novo entra em `lib/agencia/avisos/tipos.ts`. |
| Horário | Sempre America/Sao_Paulo (`lib/agencia/calendario/regras.ts`: `instanteDoDia`, `diaDe`, `horaLocal`). |
| Prova | Pela tela (Playwright na VPS, sessão do membro de teste, função temporária pelo SQL e **apagada no fim**). Evidências em `evidence/agencia-ajustes-<item>/`. Os scripts de prova anteriores em `docs/agencia/scripts/` são o molde. |
| Publicação | Arquivos só da agência: `trocar-arquivos.sh <nome>` (pede `<nome>.tgz` + `<nome>-md5.txt` com o md5 do que o teste TEM). Com migration ou arquivo compartilhado: `publicar-fase.sh`. Os dois estão em `docs/agencia/scripts/`. |

---

## Item 1 — Notas e Lembretes na ficha do cliente

**Objetivo:** registrar conversas rápidas sobre o cliente e criar "me lembre no dia X" sem abrir
uma tarefa.

**Dados (migration 9015):**
- `agencia_cliente_notas`: `id`, `cliente_id` (FK `agencia_clientes`, `on delete cascade`),
  `texto` (CHECK de 1 a 4000 caracteres), `autor_id` (FK `auth.users`, `on delete set null`),
  `criado_em`.
- `agencia_cliente_lembretes`: `id`, `cliente_id` (FK, cascade), `texto` (1 a 1000), `quando`
  (timestamptz), `membro_id` (FK `agencia_membros`, set null — quem recebe; padrão: quem criou),
  `avisado_em` (timestamptz null), `feito_em` (timestamptz null), `criado_por`, `criado_em`.
  Índice parcial `(quando) where avisado_em is null and feito_em is null`.
- As duas no regime das tabelas da agência (RLS ligada, revoke, sem policy).
- Invariante novo em `tests/invariants/agencia-notas-lembretes.test.ts` (o molde é
  `agencia-fase-8.test.ts`): anon e authenticated não leem, os CHECKs funcionam e a cascata do
  cliente apaga as linhas. Acrescente o arquivo à lista de `/root/agencia-ci/rodar-test-db.sh`.

**Servidor:**
- `app/actions/agencia/clientes-notas.ts`:
  - `criarNota`, `apagarNota` (só o autor ou quem tem `clientes.gerenciar`);
  - `criarLembrete`, `concluirLembrete`, `apagarLembrete`;
  - todas pedem acesso à área da agência e que a pessoa alcance o cliente (`podeVerCliente`).
- **Relógio:** no cron que já existe, `app/api/v1/cron/agencia-prazos/route.ts` (a cada 15 min),
  chamar `avisarLembretesDeClientes()` (novo, em `lib/agencia/clientes/lembretes.ts`). Ele avisa
  os lembretes com `quando <= now()` e `avisado_em is null` por `criarAviso` (tipo novo
  `lembrete_de_cliente`), com link `/agencia/clientes/<id>?aba=notas`. Depois grava `avisado_em`
  **no mesmo UPDATE que trava** (`… where avisado_em is null returning …`), para duas rodadas não
  avisarem duas vezes. A rota só audita quando avisou alguém (regra do CLAUDE.md sobre cron).
- Auditoria: `agencia.cliente_nota_criada` e `agencia.cliente_lembrete_criado`.

**Tela:**
- `components/agencia/clientes/FichaDoCliente.tsx` ganha a aba **"Notas"** em `ABAS_DA_FICHA`:
  - uma caixa de texto com "Adicionar nota" e a lista em ordem decrescente (autor, data, apagar);
  - ao lado (embaixo no celular), **Lembretes**: texto, dia e hora (`instanteDoDia`), "Adicionar
    lembrete", e a lista com "Feito" e o reloginho (reaproveite
    `components/agencia/trilhas/Reloginho.tsx`).
- A página `app/agencia/(area)/clientes/[id]/page.tsx` carrega as duas listas.

**Prova:**
1. Criar uma nota e um lembrete para daqui a 1 minuto.
2. Chamar a rota do cron pelo contêiner do app:

   ```bash
   docker exec deskcommcrm-teste-app-1 node -e "fetch('http://localhost:3000/api/v1/cron/agencia-prazos',{headers:{'x-cron-secret':process.env.INTERNAL_CRON_SECRET}}).then(r=>r.text()).then(console.log)"
   ```

3. Conferir `agencia_avisos` e o sininho do membro.
4. Marcar "Feito", e conferir os 375 px.

---

## Item 3 — Tarefa por voz

**Objetivo:** ditar uma tarefa no celular ("gravar o reels da padaria quinta às 10, para o João")
e receber o modal já preenchido para revisar.

**Como o D8-Crm faz (visto no código público):**
1. O navegador transcreve sozinho, pela Web Speech API (`SpeechRecognition`, `lang: "pt-BR"`,
   resultados parciais e finais), sem custo de servidor.
2. A pessoa revisa o texto numa caixa.
3. O texto vai ao servidor, que devolve os campos e o modal abre preenchido.
4. As mensagens de erro são claras: microfone negado, nenhuma fala detectada, serviço
   indisponível.

**Servidor:**
- A ação `interpretarTarefaPorVoz(texto)` em `app/actions/agencia/ia.ts` pede `tarefas.criar` e
  um texto de 3 a 2000 caracteres.
- Ela usa a porta da IA que já existe, **`pedirAIa`** (`lib/agencia/ia/modelo.ts`): chave da
  instalação, saída validada por Zod, registro em `agencia_execucoes_ia` e limite de 30 por hora.
  Exige acrescentar `"voz"` ao CHECK de `agencia_execucoes_ia.acao` (migration 9015, que pode ser a
  mesma do item 1) e ao tipo `acao` de `pedirAIa`.
- O schema Zod da resposta:
  - `{ titulo, descricao | null, cliente | null, prazo_dia | null (AAAA-MM-DD), prazo_hora | null (HH:MM), responsavel | null, prioridade, checklist: string[] }`;
  - o prompt recebe a **data de hoje** no fuso da agência, a lista de **nomes de clientes** que a
    pessoa alcança e a lista de **membros ativos**, e devolve só nomes dessas listas.
- O servidor converte o nome do cliente e o do responsável em id (comparando sem acento e sem
  caixa) e devolve os campos prontos. **Nunca cria a tarefa**: só devolve o preenchimento.
- **Sem chave de IA** (como no teste hoje), a ação devolve o erro legível, e a tela usa o texto
  ditado como **título** da tarefa, para o ditado continuar útil.

**Tela:**
- `components/agencia/tarefas/QuadroDeTarefas.tsx`: botão **"Por voz"** ao lado de "Nova tarefa".
- Componente novo `components/agencia/tarefas/TarefaPorVoz.tsx`: diálogo com "Começar a gravar" /
  "Parar", a transcrição ao vivo, a caixa editável e "Gerar tarefa".
- Ao gerar, abre o `ModalDaTarefa` **já preenchido** (acrescente ao modal uma prop de
  preenchimento inicial para tarefa nova, como o `prefixo` de `components/agencia/envios/NovoEnvio.tsx`).
- Se o navegador não tem `SpeechRecognition` (Firefox), o botão abre só a caixa de texto.

**Prova:**
- O Playwright não tem microfone. Prove a caixa de texto: digite a frase, clique em "Gerar
  tarefa" e confira o caminho sem chave (o erro e o título preenchido).
- Teste unitário da conversão de nome em id (`lib/agencia/ia/voz.ts`, puro).
- Marque como **não provado** o caminho com modelo, até haver chave de IA no teste.

---

## Item 6 — Colunas do quadro com cor e ícone (por pessoa)

**Objetivo:** cada pessoa personaliza o título, a cor e o ícone das colunas do seu quadro.
**Diferença para o D8:** lá fica no `localStorage`; aqui fica **no banco**, para valer em
qualquer aparelho.

**Dados (migration 9015):**
- `agencia_membros.preferencias jsonb not null default '{}'` com CHECK `jsonb_typeof = 'object'`.
- Formato: `{ "colunas": { "<coluna>": { "titulo": string ≤ 40, "cor": "#rrggbb", "icone": string } } }`.
  As colunas continuam as cinco de `COLUNAS` (`lib/agencia/tarefas/vocabulario.ts`): **só a
  aparência muda**, a regra do quadro não.

**Servidor:**
- A ação `salvarAparenciaDasColunas(preferencias)` em `app/actions/agencia/tarefas.ts`:
  - Zod com as cinco chaves opcionais;
  - a cor é validada por regex;
  - o ícone sai de uma lista fechada de nomes que existem em `lib/ui/icons.ts` (ListChecks,
    Clock, Flag, CheckCircle, Lightning, Star…; confira se cada um existe antes);
  - grava na linha do membro logado (`ctx.membro.id`).
- Quem não tem perfil de membro (o dono) recebe a mensagem "Ative seu perfil em Perfil".

**Tela:**
- No `QuadroDeTarefas`, um botão de engrenagem no cabeçalho de cada coluna abre um popover com
  título, cores (reaproveite `CORES_DO_BLOCO` de `lib/agencia/mapas/regras.ts`), ícones e
  "Voltar ao padrão".
- O quadro usa a preferência quando existe, com o rótulo de `ROTULO_DA_COLUNA` como padrão.

**Prova:** mudar a cor e o título de "A fazer", recarregar a página, abrir em outro contexto do
navegador (outra "máquina") e conferir que continua; depois "Voltar ao padrão".

---

## Item 7 — Relatório em PDF do cliente (o que foi feito no período)

**Objetivo:** entregar ao cliente, ou guardar, o resumo do mês: tarefas concluídas, horas por
tarefa, envios aprovados e publicações feitas.

**Servidor:**
- Rota `app/api/v1/agencia/clientes/[id]/relatorio/route.ts` (GET, `runtime = "nodejs"`), no
  **mesmo molde** do relatório do cofre: `app/api/v1/agencia/cofre/[clienteId]/relatorio/route.ts`
  com `lib/agencia/cofre/relatorio.tsx`.
  - Acesso: `contextoLiberado()` + `podeVerCliente`.
  - Parâmetros `?de=AAAA-MM-DD&ate=AAAA-MM-DD`; o padrão é o mês corrente.
- O conteúdo do relatório (`lib/agencia/clientes/relatorio.tsx`, com `@react-pdf/renderer`, que
  o projeto já usa):
  - o cabeçalho com `marcaDaSaida()`, o nome do cliente e o período;
  - as tarefas concluídas no período (título, data e responsáveis), com as **horas** somadas de
    `agencia_tarefas_tempo` (os segundos entre `inicio` e `fim`; sessão aberta não conta);
  - os envios aprovados (`agencia_aprovacoes` com `situacao` `aprovado` ou `ciente` e
    `respondido_em` no período);
  - as publicações publicadas (`agencia_publicacoes` com `publicada_em` no período);
  - os totais.
  - **Nunca** coloque senha do cofre nem dado do contrato.
- Auditoria: `agencia.relatorio_cliente_gerado` (cliente e período).

**Tela:** na ficha do cliente, aba Dados (ou um botão no topo), **"Relatório do período"** com
os campos "de" e "até" e "Baixar PDF".

**Prova:** gerar com uma tarefa concluída que tenha tempo lançado e conferir no Playwright que a
resposta é `application/pdf`. Para conferir as horas, extraia o texto do PDF com
`pdftotext`, se houver na imagem, ou confira os dados pela consulta. Guarde uma captura da tela
do botão; não guarde o PDF se ele tiver dado sensível.

---

## Item 8 — Filtro do quadro por período de criação

**Objetivo:** ver o que entrou numa semana ou num mês.

**Dados:** `agencia_tarefas.criada_em` já existe.

**Servidor:** acrescente `criada_em` ao `SELECAO` de `lib/agencia/tarefas/consultas.ts` e
`criadaEm` à interface `TarefaDoQuadro`.
- Atenção: hoje `listarTarefas` traz as abertas mais as concluídas nos **últimos 30 dias**. Com
  período escolhido, a consulta passa a filtrar por `criada_em` entre "de" e "até", **inclusive
  as concluídas**, para o período mostrar tudo o que entrou.
- Faça pela URL (`?de=&ate=`), com a página do quadro repassando o filtro a `listarTarefas`.

**Tela:**
- No `QuadroDeTarefas`, ao lado dos filtros atuais (`minhas`, `atrasadas`), o seletor **"Criadas
  em"**: Qualquer data, Hoje, Esta semana, Este mês, ou um período livre com dois campos de data.
- Um chip "Limpar" zera tudo, como "Limpar filtros" no D8.

**Prova:** com uma tarefa criada hoje e outra mais antiga (ajuste `criada_em` pelo SQL na
preparação da prova), conferir que "Hoje" mostra só a primeira e "Este mês" mostra as duas.

---

## Ordem sugerida e o que entregar em cada item

1. **Item 8**, o menor, para aquecer.
2. **Item 6**.
3. **Item 1**, que traz a migration 9015 (inclua nela também a coluna de preferências do item 6 e
   o `"voz"` do item 3, se forem juntos; senão, uma migration por item: 9015, 9016…).
4. **Item 7**.
5. **Item 3**.

Em cada item:
- typecheck e lint limpos, e os testes unitários da agência passando:

  ```bash
  npx vitest run $(ls tests/unit/agencia-*.test.ts)
  ```

- `test:db` na VPS quando houver migration;
- publicação no teste e prova pela tela;
- uma seção nova no fim de `plano-ajustes-2026-10-27.md` › Andamento, no mesmo formato das
  anteriores (o que foi feito, a prova, o que não foi provado);
- commit na `feat/agencia-ajustes`.

Ao terminar os cinco, atualize o §1 do [`CONTINUIDADE.md`](CONTINUIDADE.md).

## O que já está pronto e serve de molde

| Precisa de… | Copie o padrão de… |
|---|---|
| Ação com permissão, alcance, Zod e auditoria | `app/actions/agencia/publicacoes.ts` |
| Aviso disparado pelo relógio sem duplicar | `lib/agencia/publicacoes/motor.ts` (`publicarAgendadas`) e `lib/agencia/calendario/lembretes.ts` |
| PDF | `lib/agencia/cofre/relatorio.tsx` + a rota do cofre |
| IA com saída validada | `lib/agencia/ia/executor.ts` (`executarTarefa`) |
| Diálogo com estados e erros legíveis | `components/agencia/envios/NovoEnvio.tsx` |
| Invariante de banco | `tests/invariants/agencia-fase-8.test.ts` |
| Prova Playwright com preparo e limpeza por SQL | `docs/agencia/scripts/prova-calendario.mjs` + `calendario-*.sql` |
