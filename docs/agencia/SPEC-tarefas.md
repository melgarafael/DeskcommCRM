# Spec: `tarefas` — o sistema de tarefas da agência

> Fase 2 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **rascunho para aprovação** (24/10/2026).
> Depende de [`equipe`](SPEC-equipe.md), [`avisos`](SPEC-avisos.md), [`clientes`](SPEC-clientes.md), [`acervo`](SPEC-acervo.md).
> Referência visual: o sistema mostrado no vídeo de 17/10/2026 (quadros analisados em 23/10).

## Objetivo

O quadro de trabalho da equipe: cada coisa a fazer tem dono, cliente, prazo e
estado, e ninguém precisa perguntar "isso já foi feito?". Mandar a edição para o
editor faz o aviso chegar no WhatsApp dele; o prazo chegando avisa antes de atrasar.

### Histórias

- Como **dono**, crio a tarefa "Editar 10 vídeos — Turbo Kids", mando para dois
  editores, com prazo, e os dois são avisados.
- Como **dono**, mando para a **função** "Editor" sem escolher a pessoa; todos os
  editores veem e quem pegar vira o responsável.
- Como **editor**, clico em **Iniciar** e o cronômetro conta o tempo que levei.
- Como **dono**, crio uma tarefa recorrente "Cortes Marcos — TikTok, toda sexta, 8h".
- Como **dono**, vejo quais clientes estão com mais tarefas abertas.

## Decisões (propostas)

| # | Decisão | Por quê |
|---|---|---|
| T1 | **Colunas fixas**: Backlog · A fazer · Em andamento · Revisão · Concluído (as do vídeo). | Fluxo comum de produção; coluna livre fica para depois, se fizer falta. |
| T2 | Tarefa tem **um cliente ou nenhum** (tarefa interna da agência). | O anexo precisa de UMA pasta de cliente no Drive; tarefa de vários clientes vira uma por cliente (o "criar em lote" resolve). |
| T3 | **Responsáveis**: várias pessoas **e/ou** uma função. Tarefa só com função aparece para todos daquela função com o botão **"Pegar"**; quem pega vira responsável. | Pedido do dono: "envio para o editor e chega a notificação". |
| T4 | **Cronômetro** por pessoa: **Iniciar / Pausar / Concluir**. Mover para "Em andamento" pergunta se quer iniciar. Também dá para lançar horas e minutos à mão. O total aparece no cartão. | Pedido do dono, "principalmente no vídeo". |
| T5 | **Checklist** dentro da tarefa, e **"Criar tarefas em lote"**: cada item do checklist vira uma tarefa com os mesmos cliente, prazo, responsáveis e etiquetas. | Como no vídeo. |
| T6 | **Etiquetas** com cor (Vídeo, Gravação, Postagem…), criadas na hora; **links** com título; **anexos** no Drive (spec acervo). | Como no vídeo. |
| T7 | **Quem executa: humano ou IA** (D17). Nesta fase só existe "humano"; o campo nasce para a Fase 9 não refazer as tarefas. | Decisão do mapa. |
| T8 | **Avisos**: tarefa atribuída avisa na hora; prazo avisa nos dias de antecedência configurados (Fase 1), **no dia** e **quando atrasa** — para todos os responsáveis (A6). Cada marco avisa **uma vez só**. | Spec avisos. |
| T9 | **Tarefas recorrentes**: título, descrição, cliente, etiquetas, responsáveis/função, padrão (diária · semanal com os dias · mensal com o dia), hora, início, fim opcional e ativa. A lista mostra a **próxima execução**. | Como no vídeo. |
| T10 | Os dois relógios (prazos a cada 15 min; recorrentes a cada hora) são **rotas de cron** novas, chamadas pelo serviço `scheduler`. | Padrão de todo cron do produto. **Consequência:** o `scheduler` do teste ainda é a imagem do projeto original; para conhecer as rotas novas, ele passa a ser construído com o código do fork, como já é feito com o app e o worker. |
| T11 | **Visibilidade**: quem tem `tarefas.ver_todas` vê tudo; os demais veem as tarefas em que são responsáveis ou da função deles, sempre dentro dos clientes que podem ver (spec clientes, C5). | Fase 1 já declarou `tarefas.ver_todas`. |

## Dados

Mesma migration da fase (spec clientes). Tabelas da instalação, RLS + revoke, servidor.

```sql
create table if not exists public.agencia_tarefas (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  coluna        text not null default 'a_fazer'
                check (coluna in ('backlog','a_fazer','em_andamento','revisao','concluido')),
  posicao       numeric not null default 0,      -- fractional indexing, nunca int (CLAUDE.md)
  prioridade    text not null default 'media' check (prioridade in ('baixa','media','alta','urgente')),
  prazo         timestamptz,                     -- nulo = sem prazo
  cliente_id    uuid references public.agencia_clientes(id) on delete set null,
  funcao_id     uuid references public.agencia_funcoes(id),   -- T3: atribuída a uma função
  executor      text not null default 'humano' check (executor in ('humano','ia')),  -- T7
  recorrente_id uuid,                            -- FK para agencia_tarefas_recorrentes
  concluida_em  timestamptz,
  criada_em     timestamptz not null default now(),
  criada_por    uuid references auth.users(id) on delete set null
);
create table if not exists public.agencia_tarefas_responsaveis (tarefa_id uuid, membro_id uuid, primary key (tarefa_id, membro_id));
create table if not exists public.agencia_tarefas_checklist   (id uuid primary key, tarefa_id uuid, texto text, feito boolean, ordem int);
create table if not exists public.agencia_tarefas_links       (id uuid primary key, tarefa_id uuid, titulo text, url text);
create table if not exists public.agencia_etiquetas           (id uuid primary key, nome text unique, cor text);
create table if not exists public.agencia_tarefas_etiquetas   (tarefa_id uuid, etiqueta_id uuid, primary key (tarefa_id, etiqueta_id));
create table if not exists public.agencia_tarefas_tempo (      -- T4
  id         uuid primary key default gen_random_uuid(),
  tarefa_id  uuid not null references public.agencia_tarefas(id) on delete cascade,
  membro_id  uuid not null references public.agencia_membros(id),
  inicio     timestamptz not null,
  fim        timestamptz,                         -- nulo = cronômetro rodando
  manual     boolean not null default false
);
-- um cronômetro rodando por pessoa:
create unique index if not exists agencia_tempo_um_rodando on public.agencia_tarefas_tempo (membro_id) where fim is null;
create table if not exists public.agencia_tarefas_recorrentes (/* T9: padrão, dias, dia_do_mes, hora, inicio, fim, ativa, proxima_execucao + o molde da tarefa */);
create table if not exists public.agencia_avisos_de_prazo (     -- T8: cada marco avisa uma vez
  tarefa_id uuid not null references public.agencia_tarefas(id) on delete cascade,
  marco     text not null,                        -- 'antes_3d', 'antes_1d', 'no_dia', 'atrasou'
  primary key (tarefa_id, marco)
);
```

(As FKs e `on delete cascade` completos entram na migration; o bloco acima resume.)

## Telas

| Rota | Conteúdo |
|---|---|
| `/agencia/tarefas` | **Quadro** (as 5 colunas, arrastar e soltar), **Lista** (padrão no celular), **Ranking** (clientes com mais tarefas abertas). Filtros: cliente, responsável, função, etiqueta, "só as minhas", "atrasadas". Busca por título. Botões "Nova tarefa" e "Recorrentes". |
| Cartão | Título, cliente, etiquetas coloridas, fotos/iniciais dos responsáveis, prazo, tempo total, item do checklist (3/5). **Borda vermelha** atrasada; verde e riscada concluída. |
| Modal da tarefa | Título, checklist (com "criar em lote"), descrição, coluna, prioridade, prazo com hora, cliente, responsáveis e função, etiquetas (+ nova), links, anexos (Drive), cronômetro e lançamento manual, quem executa. |
| `/agencia/tarefas/recorrentes` | Lista com padrão, hora, próxima execução e ativa; criar/editar/pausar. |
| Ficha do cliente › Tarefas | As tarefas daquele cliente. |
| Início (`/agencia`) | "Minhas tarefas de hoje" e "atrasadas", com o cronômetro que estiver rodando. |

Nova entrada no menu: **Tarefas** (todo membro) e **Clientes** (todo membro).
No celular a barra mostra Início · Tarefas · Clientes · Perfil (Equipe e
Configurações vão para o menu "Mais").

## Auditoria

`agencia.tarefa_criada`, `agencia.tarefa_alterada`, `agencia.tarefa_movida`,
`agencia.tarefa_atribuida`, `agencia.tarefa_concluida`, `agencia.tarefas_em_lote`,
`agencia.recorrente_criada`, `agencia.recorrente_alterada`. O cron só audita quando
gerou tarefa ou mandou aviso (CLAUDE.md › rodada vazia não audita).

## Testes

- **Unit:** posição entre dois cartões (`midpoint`); quem vê qual tarefa (T11);
  "pegar" tarefa da função; próximo horário de cada padrão de recorrência (diária,
  semanal com dias, mensal no dia 31 em mês de 30); marcos de prazo com a
  antecedência configurada e "cada marco uma vez"; soma do tempo com cronômetro
  rodando; um cronômetro rodando por pessoa.
- **Invariante:** RLS/revoke das tabelas novas; `unique` do cronômetro; o cron
  rodado duas vezes não gera tarefa nem aviso em dobro.
- **Prova pela tela no teste** (dono no navegador daqui, membro no navegador limpo
  da VPS): criar tarefa para dois editores → os dois veem e recebem o aviso no
  sininho → um inicia o cronômetro e conclui → prazo vencido fica vermelho e gera o
  aviso "atrasou" → tarefa só da função aparece para todos os editores e some dos
  outros quando alguém pega → recorrente gera a tarefa no horário. 375 e 1280 px.

## Critérios de aceite

1. Criar, editar, mover entre colunas (arrastando) e concluir tarefas pela tela.
2. Atribuir a duas pessoas avisa as duas; atribuir a uma função avisa todos da função, e "Pegar" transfere.
3. Avisos de prazo saem nos dias configurados, no dia e no atraso, **uma vez cada**.
4. Cronômetro conta, pausa e soma; lançamento manual entra no total.
5. "Criar em lote" gera uma tarefa por item do checklist.
6. Recorrente gera a tarefa no padrão e mostra a próxima execução.
7. Ranking ordena os clientes pelas tarefas abertas.
8. Membro sem `tarefas.ver_todas` não vê nem abre tarefa de outro (recusa no servidor).
9. Tudo usável em 375 px.

## Fora desta fase

- Visão **Agenda** (semana) — vem com o calendário (Fase 3).
- Comentários na tarefa e aprovação do cliente — Fase 7.
- Execução pela IA — Fase 9 (o campo já existe).

## Perguntas em aberto

- **T1** — As 5 colunas servem, ou vocês usam outras?
- **T2** — Tarefa com um cliente só está bom?
- **T4** — Mover para "Em andamento" deve **iniciar o cronômetro sozinho**, ou só perguntar?
- **T10** — Ok reconstruir o `scheduler` do teste com o código do fork (mesmo processo do worker)?
