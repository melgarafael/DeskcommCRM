# Spec: `whatsapp-agencia` — o WhatsApp que fala pela agência

> Fase 1 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **aprovada** pelo dono em 23/10/2026.
> Irmãos: [`equipe`](SPEC-equipe.md), [`avisos`](SPEC-avisos.md).

## Objetivo

Dizer ao sistema **qual WhatsApp é o da agência** e dar às outras partes um jeito
único e seguro de mandar mensagem por ele. Nesta fase o uso é: convite de membro e
avisos para a equipe. Depois: grupo do cliente (Fase 6) e aviso de aprovação no grupo
(Fase 7).

## O que já existe e será reaproveitado

O sistema já avisa a equipe de suporte pelo WhatsApp quando a IA abre um caso
(`lib/escalacao/aviso-ao-suporte.ts`). Esse caminho já resolve o difícil:

- **Transporte sem conhecer provedor** — `criarTransporteDoAviso()` (no
  `aviso-ao-suporte.handler.ts`) monta o envio a partir da linha do canal, seja WAHA
  ou API oficial.
- **Anti-bloqueio** — `criarPacingDoCanal()` aplica o espaçamento entre mensagens e o
  teto diário do warm-up, e registra cada envio no `pacing_ledger`. Um número banido
  derruba o atendimento da organização inteira, então nenhuma mensagem da agência
  passa por fora disso.
- **Entrega pelo `event_log`** — o envio nunca acontece dentro da tela: a tela grava
  um evento, o dreno entrega, e espera vira `retry` sem contar tentativa.

Esta spec **não** cria um segundo caminho de envio: ela generaliza a porta do
transporte para o remetente "agência" e usa a mesma regra de pacing.

## Decisões (propostas)

| # | Decisão | Por quê |
|---|---|---|
| W1 | O WhatsApp da agência é **um canal já conectado** em alguma organização da central (provavelmente a da própria agência). A configuração guarda o par `organization_id` + `channel_session_id`. | O transporte exige a organização dona do canal (issue #236: só o `sessionRef` faria a mensagem sair pela conta errada). |
| W2 | **Janela de horário para a equipe: 7h–22h**, no fuso da organização do canal. Aviso criado fora dela espera a abertura. Configurável. | Diferente do suporte (que pediu aviso na hora), aqui são prazos e tarefas — nada que justifique acordar alguém. |
| W3 | Cada envio fica registrado em `agencia_envios_whatsapp`. Se a mensagem voltar pelo webhook (`fromMe=true`) e aparecer como conversa na Inbox da organização da agência, **está aceito** pelo dono — não se constrói filtro para isso. | Decisão do dono em 23/10/2026. |
| W4 | O número da agência é conectado por **QR Code (WAHA)** numa **organização própria da agência** criada na central (hoje ele não está em nenhuma). | Avisos livres sem modelo aprovado nem custo por mensagem, e criação de grupo (Fase 6). |

## Dados

```sql
-- Configuração única da instalação (uma linha).
create table if not exists public.agencia_config (
  id                     boolean primary key default true check (id),
  canal_organization_id  uuid references public.organizations(id) on delete set null,
  canal_session_id       uuid references public.channel_sessions(id) on delete set null,
  janela_inicio          time not null default '07:00',
  janela_fim             time not null default '22:00',
  avisos_antecedencia    int[] not null default '{2,1}',   -- usado pela spec de avisos
  atualizado_em          timestamptz not null default now(),
  atualizado_por         uuid references auth.users(id)
);

-- Cada mensagem que a agência mandou (ou tentou).
create table if not exists public.agencia_envios_whatsapp (
  id             uuid primary key default gen_random_uuid(),
  motivo         text not null check (motivo in ('convite','aviso','teste')),
  referencia_id  uuid,                 -- convite ou aviso que originou
  telefone       text not null,        -- E.164; mascarado em log e na tela
  corpo          text not null,
  situacao       text not null default 'pendente'
                 check (situacao in ('pendente','enviado','falhou','descartado')),
  tentativas     int not null default 0,
  erro_codigo    text,
  external_id    text,
  criado_em      timestamptz not null default now(),
  enviado_em     timestamptz
);
```

RLS ligada, nenhuma policy para `anon`/`authenticated`: só o servidor lê e escreve.
O canal escolhido é validado no servidor (`channel_sessions` com aquela
`organization_id`, conectado), nunca confiando no que veio do formulário.

## Como funciona

1. Quem quer mandar chama `enfileirarWhatsappDaAgencia({ motivo, referenciaId, telefone, corpo })`,
   que grava a linha `pendente` e emite `agencia.whatsapp_enfileirado` no `event_log`.
2. O handler do evento (mesmo formato de `aviso-ao-suporte.handler.ts`):
   - sem configuração → `skipped("sem_configuracao")` (nunca `error`, para não virar evento morto);
   - fora da janela → `retry` para a abertura;
   - pacing não liberou → `retry` no horário que ele indicar;
   - canal caído → `retry` em 5 min, até o teto de tentativas;
   - envio → `enviado` com `external_id`, registra no `pacing_ledger`, `ok`.
3. Teto de idade: aviso com mais de 24 h sem sair vira `descartado` (um aviso velho é ruído).

## Tela

Em `/agencia/configuracoes` (permissão `configuracoes.gerenciar`):

- **WhatsApp da agência** — lista dos canais conectados da instalação (organização +
  número + estado). Escolher um e salvar.
- **Horário dos avisos** — início e fim.
- **Enviar mensagem de teste** — para o próprio WhatsApp de quem clicou; mostra
  "na fila", depois "enviado" ou o motivo da falha em português.
- **Últimos envios** — os 20 mais recentes, com telefone mascarado e situação.

## Auditoria

`agencia.whatsapp_configurado`, `agencia.whatsapp_teste_enviado`.

## Testes

- **Unit** (relógio, banco e transporte falsos, como `aviso-ao-suporte`): sem config →
  skipped; fora da janela → retry na abertura; pacing segurando → retry; transporte
  recusando → tentativas e depois `falhou`; aviso velho → `descartado`; envio → `ok` e
  ledger registrado; telefone sempre mascarado no log.
- **Invariante:** `anon`/`authenticated` não leem `agencia_config` nem `agencia_envios_whatsapp`.
- **E2E:** dono escolhe o canal e manda o teste; a tela mostra a situação. Envio real
  provado com o WAHA local, não com mock (doutrina de QA com recursos reais).

## Limites

- **Sempre:** todo envio da agência passa por `enfileirarWhatsappDaAgencia` + pacing.
- **Perguntar antes:** mudar a assinatura do transporte compartilhado com o aviso de suporte.
- **Nunca:** enviar dentro de request de tela; enviar sem pacing; telefone completo em log.

## Fica para depois (já previsto aqui)

- **Criar grupo** com participantes (Fase 6): o adapter WAHA ainda não tem a chamada;
  ela entra como método novo na porta do transporte, com o mesmo pacing.
- **Mensagem para grupo** (Fase 7).

## Critérios de aceite

1. Sem canal configurado, nada quebra: o convite mostra o link para copiar e os
   eventos terminam como `skipped`.
2. Com canal configurado, a mensagem de teste chega no WhatsApp de quem clicou.
3. Mensagens seguidas respeitam o espaçamento do canal (medido nos horários de `enviado_em`).
4. Aviso criado às 23h sai às 7h.
## Respostas (23/10/2026)

- **W1/W4** — O número existe e não está conectado. Pré-requisito operacional (do
  dono, fora do código): criar a organização da agência na central e conectar o número
  por QR Code.
- **W2** — 7h–22h confirmado, editável na tela.
- **W3** — Eco na Inbox aceito.
