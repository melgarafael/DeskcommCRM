# Spec: `avisos` — sininho e WhatsApp pessoal da equipe

> Fase 1 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **aprovada** pelo dono em 23/10/2026.
> Depende de [`equipe`](SPEC-equipe.md) e [`whatsapp-agencia`](SPEC-whatsapp-agencia.md).

## Objetivo

Um jeito único de avisar alguém da agência: o aviso aparece no **sininho** da área
da agência e, se a pessoa quiser, chega também no **WhatsApp pessoal** dela,
mandado pelo WhatsApp da agência.

Nesta fase o motor fica pronto e é provado com o aviso de teste e o convite. Quem
mais vai usá-lo vem depois: tarefa atribuída e prazo chegando (Fase 2), reunião
marcada (Fase 3), etapa desbloqueada (Fase 4), cliente aprovou (Fase 7).

## Decisões (propostas)

| # | Decisão |
|---|---|
| A1 | **Um aviso, dois caminhos.** Criar um aviso grava a linha do sininho; se o membro aceita WhatsApp, enfileira também o envio. O sininho é a verdade; o WhatsApp é cópia. |
| A2 | **Cada membro escolhe** se recebe no WhatsApp (padrão: sim). |
| A3 | **A antecedência dos avisos de prazo é da agência**, não de cada membro: uma lista de dias editável (ex.: 3, 2 e 1 dia antes), mais "no dia" e "atrasou", que são fixos. Fica em `agencia_config.avisos_antecedencia`. Só passa a valer quando houver prazos, na Fase 2. |
| A6 | **Quem recebe.** Aviso de prazo de uma tarefa vai para **todos os responsáveis** dela (duas pessoas designadas = as duas avisadas). Aviso **geral** (prazo da trilha, fim do mês de preparação) vai para quem tem a permissão `avisos.gerais` — o dono sempre. A regra mora numa função só, `destinatariosDoAviso()`, para as fases seguintes não decidirem cada uma do seu jeito. |
| A4 | **Agrupar para não inundar:** o aviso no WhatsApp espera **3 minutos** antes de sair; os avisos do mesmo tipo para a mesma pessoa que chegarem nesse meio-tempo entram na mesma mensagem ("Você tem 4 tarefas novas: …"). O sininho mostra cada um na hora. (Esta linha dizia 10 minutos; ficou 3 porque "você recebeu uma tarefa" dez minutos depois já é tarde.) |
| A5 | O texto do aviso **não leva dado sensível** (senha, valor de contrato). Leva o título e o link para abrir na área. |

## Dados

```sql
create table if not exists public.agencia_avisos (
  id            uuid primary key default gen_random_uuid(),
  membro_id     uuid not null references public.agencia_membros(id) on delete cascade,
  tipo          text not null,       -- vocabulário fixo no TypeScript (abaixo); sem CHECK, cresce por fase
  titulo        text not null,
  corpo         text,
  link          text,                -- caminho interno, ex.: /agencia/tarefas/<id>
  referencia_id uuid,                -- tarefa, reunião… (polimórfico, com tipo padronizado)
  criado_em     timestamptz not null default now(),
  lido_em       timestamptz
);
create index if not exists agencia_avisos_membro_nao_lidos
  on public.agencia_avisos (membro_id, criado_em desc) where lido_em is null;

alter table public.agencia_membros
  add column if not exists recebe_whatsapp boolean not null default true;
```

RLS: o membro lê e marca como lido **só os próprios** avisos (`membro_id` do usuário
corrente, resolvido por função `security definer`). Criar aviso é só do servidor.
Realtime ligado na tabela para o sininho atualizar sem recarregar.

### Tipos de aviso

Constante compartilhada em `lib/agencia/avisos/tipos.ts` — nunca string solta
(regra das colunas de vocabulário aberto, CLAUDE.md › Modelagem).

| Tipo | Fase |
|---|---|
| `teste` | 1 |
| `convite_aceito` (avisa o dono) | 1 |
| `tarefa_atribuida`, `prazo_chegando`, `prazo_hoje`, `prazo_atrasado` | 2 |
| `reuniao_marcada` | 3 |
| `etapa_liberada` | 4 |
| `aprovacao_respondida` | 7 |

## Como funciona

`criarAviso({ membroId, tipo, titulo, corpo, link, referenciaId })`, no servidor:

1. Grava em `agencia_avisos`.
2. Membro ativo, com `recebe_whatsapp` e WhatsApp configurado → enfileira pela spec
   `whatsapp-agencia` com motivo `aviso`, respeitando o agrupamento de 10 minutos.
3. Não lança se o WhatsApp falhar: o sininho já registrou, e a falha fica visível em
   "Últimos envios".

**Laço de retorno** (sistema vivo, invariante 7): um aviso de WhatsApp que termina em
`falhou` aparece para o dono em "Últimos envios" e marca o membro com "WhatsApp não
entregue" na lista da equipe — o erro tem para onde voltar.

## Tela

- **Sininho** na casca da área: contador de não lidos, lista com os 30 mais recentes,
  clicar abre o link e marca como lido, "marcar todos como lidos".
- **`/agencia/perfil`**: "Receber avisos no meu WhatsApp" (liga/desliga) e o número cadastrado.
- **`/agencia/configuracoes`** (`configuracoes.gerenciar`): antecedência dos avisos de
  prazo — adicionar ou remover dias (de 1 a 7), com o texto "Avisos de prazo passam a
  valer quando as tarefas chegarem".
- **Botão "Enviar aviso de teste"**, por membro, na lista da equipe.

## Testes

- **Unit:** aviso grava no sininho mesmo com WhatsApp desligado ou sem config; membro
  desativado não recebe; agrupamento junta avisos do mesmo tipo em 10 min e separa tipos
  diferentes; antecedência aceita só 1–7, sem repetição.
- **Invariante:** membro A não lê aviso do membro B; `anon` não lê nada.
- **E2E:** dono manda aviso de teste ao membro → aparece no sininho do membro sem recarregar
  e chega no WhatsApp (WAHA local); membro desliga o WhatsApp no perfil → o próximo teste
  só aparece no sininho. Em 375 px e 1280 px.

## Limites

- **Sempre:** toda notificação da agência nasce por `criarAviso`.
- **Nunca:** senha, valor ou dado do cofre no texto de um aviso.

## Critérios de aceite

1. O aviso de teste aparece no sininho do membro em até 3 s, sem recarregar.
2. Com WhatsApp ligado, chega também no WhatsApp pessoal dele.
3. Com WhatsApp desligado no perfil, só o sininho recebe.
4. Um membro nunca vê o aviso de outro (provado no banco, não só na tela).
5. A lista de antecedência salva e reabre com os mesmos dias.
6. Falha de entrega fica visível para o dono.

## Respostas (23/10/2026)

- **A3/A6** — Prazo de tarefa avisa todos os responsáveis; aviso geral avisa o administrador da agência.
- **A4** — Agrupamento confirmado.
