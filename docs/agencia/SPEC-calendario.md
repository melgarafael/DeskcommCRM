# Spec: `calendario` — reuniões e agenda da agência

> Fase 3 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **aprovada** pelo dono em 24/10/2026, "com as sugestões como estão" (K1, K3, K4 e K7 como propostos).
> Depende de [`equipe`](SPEC-equipe.md), [`avisos`](SPEC-avisos.md), [`clientes`](SPEC-clientes.md),
> [`acervo`](SPEC-acervo.md) e [`tarefas`](SPEC-tarefas.md).
> O **calendário de postagens** fica na Fase 8, com as publicações (mapa, D16/`publicacoes`).

## Objetivo

Um lugar para ver e marcar o que a agência tem na semana: as **reuniões** com cada
cliente (Apresentação, Fechamento, Ativação…) e os **prazos das tarefas**. Marcar
uma reunião online cria o link do **Google Meet** sozinho, põe na agenda Google da
agência, convida o cliente e avisa a equipe.

### Histórias

- Como **dono**, marco a Apresentação da Turbo Kids para segunda às 10h, online,
  com o Gabriel e o editor; o Meet é criado, o cliente recebe o convite e uma
  mensagem no WhatsApp, e o Fechamento já fica marcado para a segunda seguinte.
- Como **membro**, vejo minha semana com as reuniões em que estou e as tarefas que
  vencem, e recebo lembrete 1 dia e 1 hora antes.
- Como **dono**, depois da reunião marco "realizada", escrevo a ata e anexo a gravação.

## Decisões (propostas)

| # | Decisão | Por quê |
|---|---|---|
| K1 | **Uma conexão Google da agência** para Drive e Agenda: a mesma conta (AI Pro) passa a autorizar também `calendar.events`. Quem já conectou o Drive clica em "Reconectar" uma vez. | Uma conta, um botão; o app OAuth já tem a Agenda liberada (é o da Agenda). |
| K2 | Reunião **online** cria o evento na agenda principal dessa conta **com Google Meet** (`conferenceData`), e o Google manda o convite por e-mail a todos os participantes que têm e-mail. | O Google já resolve convite, link e lembrete no celular de cada um. |
| K3 | **Só ida**: o que se muda na central vai para o Google; o que se muda direto no Google Agenda **não volta**. A central é a fonte. | Sincronizar nos dois sentidos é outra fase inteira (a Agenda das organizações tem isso e é grande). |
| K4 | O **cliente** recebe também uma mensagem no **WhatsApp da agência** com dia, hora e link (chave por reunião, ligada por padrão), dentro do horário de avisos. | O cliente vive no WhatsApp; e-mail de convite costuma ficar sem ver. |
| K5 | Ao marcar uma **Apresentação**, a opção **"Marcar o Fechamento uma semana depois"** já vem ligada e cria a segunda reunião no mesmo horário, D+7 (regra da Etapa 1). Arrastar o Fechamento quando a Apresentação muda fica para a trilha (Fase 4). | Regra do dono; o automático completo é da Fase 4. |
| K6 | A Apresentação já nasce com a **pauta** preenchida pelo checklist do apêndice A do mapa (objetivo, produto, público, concorrentes, ticket…), editável. | Pedido do dono: um checklist para não esquecer pergunta. |
| K7 | **Lembretes** para os participantes da agência: **1 dia e 1 hora antes** (configurável em Configurações), no sininho e no WhatsApp. Rodam no relógio que já existe (`agencia-prazos`, a cada 15 min) — sem cron novo, sem reconstruir o agendador. | Reaproveita o que já está no ar. |
| K8 | Depois da reunião: **situação** (marcada, realizada, remarcada, cancelada, não compareceu), **ata** e **gravação** (link, ou arquivo enviado para a pasta do cliente no Drive, subpasta "03 Planejamento"). | Pedido do dono: gravar a Apresentação e usar no planejamento. |
| K9 | **Quem vê**: reuniões dos clientes que a pessoa alcança (C5) e as internas em que ela está. **Quem marca**: `calendario.gerenciar` (já no vocabulário desde a Fase 1). | Mesma régua dos clientes e tarefas. |
| K10 | Sem Google conectado, nada quebra: a reunião é marcada na central, sem Meet nem convite do Google, e a tela diz o que falta. | Mesmo princípio do Drive (A6). |

## Dados

Migration 9005 + apêndice no `baseline.sql` antes da varredura de anon; mesmo
regime das 9003/9004 (instalação, RLS, `revoke all`, só o servidor).

```sql
create table public.agencia_reunioes (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null,   -- apresentacao | fechamento | ativacao | mensal | interna | outra (CHECK)
  titulo           text not null,
  cliente_id       uuid references public.agencia_clientes(id) on delete set null,
  inicio           timestamptz not null,
  fim              timestamptz not null,           -- CHECK fim > inicio
  formato          text not null,   -- online | presencial | ligacao (CHECK)
  local            text,            -- endereço, quando presencial
  pauta            text,
  ata              text,
  situacao         text not null default 'marcada', -- marcada | realizada | remarcada | cancelada | nao_compareceu (CHECK)
  avisar_cliente   boolean not null default true,
  google_event_id  text,
  meet_url         text,
  gravacao_url     text,
  origem_id        uuid references public.agencia_reunioes(id) on delete set null, -- o Fechamento aponta para a Apresentação (K5)
  criada_em        timestamptz not null default now(),
  atualizada_em    timestamptz not null default now(),
  criada_por       uuid references auth.users(id) on delete set null
);
create table public.agencia_reunioes_membros   (reuniao_id uuid, membro_id uuid, primary key (reuniao_id, membro_id));
create table public.agencia_reunioes_convidados (id uuid primary key, reuniao_id uuid, nome text, whatsapp text, email text);
create table public.agencia_lembretes_de_reuniao (reuniao_id uuid, marco text, primary key (reuniao_id, marco)); -- K7: uma vez cada
-- agencia_config ganha: reunioes_lembretes int[] default '{1440,60}' (minutos antes)
-- agencia_drive passa a guardar também os escopos concedidos (para saber se a Agenda foi liberada)
```

Novos tipos de aviso: `reuniao_marcada` (já previsto na Fase 1), `reuniao_alterada`,
`reuniao_lembrete`. Novo motivo de envio de WhatsApp: `reuniao` (para o cliente).

## Telas

| Rota | Conteúdo |
|---|---|
| `/agencia/calendario` | **Semana** (padrão no computador): colunas de segunda a domingo, faixa das 7h às 22h, reuniões coloridas pelo tipo e os prazos das tarefas como marcadores; **Mês**; **Próximos** (lista, padrão no celular). Filtros: cliente, pessoa, "só as minhas". Clicar num horário vazio abre "Nova reunião" já com o horário. |
| Modal da reunião | Tipo, título (sugerido: "Apresentação — Turbo Kids"), cliente, data, início e fim, formato (online com Meet / presencial com endereço / ligação), participantes da agência, convidados do cliente (já preenchidos com o responsável do cadastro), pauta, "avisar o cliente no WhatsApp", e na Apresentação "marcar o Fechamento uma semana depois". Depois de salvar: link do Meet, "abrir no Google Agenda", situação, ata e gravação. |
| Ficha do cliente › **Reuniões** | Aba nova: as reuniões daquele cliente, passadas e próximas. |
| Início | Ganha "Reuniões de hoje". |
| Configurações | Os lembretes de reunião (1 dia, 1 hora…), e a conexão Google mostra se a Agenda está liberada. |

Menu: entra **Calendário** (todo membro). No celular: Início · Tarefas · Calendário · Mais.

## Auditoria

`agencia.reuniao_marcada`, `agencia.reuniao_alterada`, `agencia.reuniao_cancelada`,
`agencia.reuniao_realizada`, `agencia.lembretes_de_reuniao_enviados` (só quando houve envio).

## Testes

- **Unit:** semana e mês montados no fuso de Brasília (segunda a domingo); D+7 do
  Fechamento; marcos de lembrete (1440/60 min) e "cada marco uma vez"; quem vê qual
  reunião (K9); corpo do evento do Google com Meet e convidados; texto do WhatsApp
  ao cliente sem dado sensível.
- **Invariante:** RLS/revoke das tabelas novas; `fim > inicio`; lembrete único por marco.
- **Prova pela tela no teste:** marcar Apresentação online com Fechamento automático →
  as duas aparecem na semana → com o Google conectado, o evento e o Meet existem na
  agenda da conta → o membro vê na semana dele e recebe o aviso → o relógio manda o
  lembrete 1 vez → marcar como realizada com ata. 375 e 1280 px.

## Critérios de aceite

1. Marcar, remarcar e cancelar reunião pela tela, com auditoria.
2. Reunião online com Google conectado cria o evento com link do Meet e convida quem tem e-mail.
3. O cliente recebe a mensagem no WhatsApp da agência (quando ligado e o WhatsApp estiver configurado).
4. Apresentação com a opção ligada cria o Fechamento uma semana depois, no mesmo horário.
5. Lembretes saem nos marcos configurados, uma vez cada, para os participantes da agência.
6. A semana mostra reuniões e prazos de tarefas no horário de Brasília; o celular abre em "Próximos".
7. Membro sem acesso ao cliente não vê a reunião dele (recusa no servidor).
8. Sem Google conectado, a reunião é marcada e a tela diz o que falta.

## Fora desta fase

- Puxar de volta o que for mudado direto no Google Agenda (K3).
- Calendário de postagens (Fase 8).
- O Fechamento acompanhar a Apresentação remarcada e a trilha inteira (Fase 4).
- Pedir ao cliente que escolha um horário livre (link de agendamento) — pode entrar na trilha.

## Perguntas em aberto

- **K1** — Mesma conta Google (a do AI Pro) para o Drive e a Agenda?
- **K4** — O cliente recebe também pelo WhatsApp, além do convite do Google?
- **K7** — Lembretes 1 dia e 1 hora antes estão bons?
- **K3** — Tudo bem o que for mudado direto no Google Agenda não voltar para a central?
