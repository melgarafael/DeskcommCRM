# Relógio para instalação sem agendador (follow-up não fica preso)

## Quando este runbook se aplica

O caminho do produto é o self-host, e lá o agendador já vem junto: o serviço
`scheduler` do compose bate cada rota na cadência do
`docker/scheduler/entrypoint.sh` (follow-up, dreno, dispatcher, agenda…).

Este runbook é para a instalação que **não** tem esse serviço — hospedagem
gerenciada sem cron de minuto, ou um deploy em que o `scheduler` não está de pé.
Aí o relógio precisa vir de fora.

### O caso concreto: um FORK num plano que só agenda 1 cron por dia

Este repositório não é hospedado na Vercel, mas **um fork pode ser** — e o plano
gratuito de lá é o exemplo canônico de agendador que dispara uma vez ao dia. Duas
regras valem para quem hospeda assim:

- **Expressões de minuto derrubam o deploy no plano gratuito.** É o que o cabeçalho
  do `vercel.ts` da raiz já avisa: nesse plano cabe uma entrada diária só. Deixe uma
  (o `lgpd-sla-watcher` é a sugestão de lá) e traga o resto do relógio de fora, pelas
  opções A e B abaixo.
- **Não crie um `vercel.json` ao lado do `vercel.ts`: a Vercel recusa os dois.** Este
  repositório traz só o `.ts` — `ls vercel.json` não acha nada.

O `vercel.ts` é o inventário de crons do fork, com as mesmas rotas e a mesma cadência
do `docker/scheduler/entrypoint.sh`; `tests/unit/cron-routes-scheduled.test.ts` reprova
quando as duas listas de **rotas** divergem — a cadência não está sob gate —, então rota de
cron nova entra nos dois arquivos.

## Por que existe

Sem nada batendo de poucos em poucos minutos:

1. o lead responde "SIM" no WhatsApp;
2. a mensagem entra no banco (inbox OK);
3. o enrollment fica em `waiting_reply` / `cap_nome` para sempre.

O endpoint `POST /api/v1/system/relogio/tick` drena eventos, aplica respostas
inbound nos follow-ups e envia textos fixos pendentes. Quem precisa chamar
esse endpoint a cada poucos minutos é um **cron de fora** — grátis.

## Pré-requisito: um só endereço para a UI e para o webhook

O webhook do WAHA tem que bater na **mesma** instalação que serve a UI e
`webhooks/in`. Se o domínio do webhook apontar para um deploy e a UI para
outro, o tick anda numa instalação e o "SIM" chega na outra — o follow-up fica
preso com a mensagem visível na inbox.

Confirme nos logs: `POST /api/v1/webhooks/waha` e `POST /api/v1/webhooks/in`
têm de chegar no mesmo lugar em que o tick bate.

## Opção A — GitHub Actions (grátis em repo público)

Arquivo: [`.github/workflows/relogio.yml`](../../.github/workflows/relogio.yml).

**Limitação:** o `schedule:` do Actions **só roda na branch default (`main`)**.
Se o workflow existir só numa branch de trabalho, o cron **nunca** dispara.

### Ligar

1. Mergeie `.github/workflows/relogio.yml` em `main` (ou copie o arquivo).
2. No GitHub do **seu** fork/instalação → Settings → Secrets and variables:

| Tipo | Nome | Valor |
|------|------|--------|
| Variable | `RELOGIO_LIGADO` | `1` |
| Secret | `RELOGIO_APP_URL` | `https://SEU-DOMINIO` (sem barra no fim) |
| Secret | `RELOGIO_SECRET` | o mesmo `INTERNAL_SECRET` do `.env` da sua instalação |

3. Actions → **relogio** → Run workflow (teste manual).
4. Espere o schedule `*/5` (o GitHub atrasa; 5–15 min é normal).

```bash
# Via CLI (com permissão de secrets no repo)
gh variable set RELOGIO_LIGADO -R SEU_USER/DeskcommCRM -b 1
gh secret set RELOGIO_APP_URL -R SEU_USER/DeskcommCRM -b "https://SEU-DOMINIO"
gh secret set RELOGIO_SECRET -R SEU_USER/DeskcommCRM -b "$INTERNAL_SECRET"
```

## Opção B — cron-job.org (grátis, a cada 1 minuto)

Melhor latência que o Actions. Conta free permite job a cada minuto.

1. Crie conta em [https://cron-job.org](https://cron-job.org).
2. Create cronjob:
   - **URL:** `https://SEU-DOMINIO/api/v1/system/relogio/tick`
   - **Schedule:** every 1 minute
   - **Request method:** POST
   - **Header:** `Authorization` = `Bearer <INTERNAL_SECRET>`
3. Enable e rode "Execute now".

O curl equivalente:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $INTERNAL_SECRET" \
  "https://SEU-DOMINIO/api/v1/system/relogio/tick"
```

## Como saber que está funcionando

Nos logs da sua instalação, a cada batida:

- `POST /api/v1/system/relogio/tick` → 200
- quando há "SIM" preso: `[relogio] follow-up avancou por resposta inbound`

Na fila de follow-ups, o status sai de **Aguardando resposta**.

## O que o tick faz (ordem)

1. `event-log-drain` — consome `message.received` (reatividade do follow-up)
2. `followup-flow-worker` — aplica texto inbound + claim de enrollments + envio fixo
3. `routing-worker`
4. `recover-stuck-messages`

Definição canônica: `lib/relogio/tarefas.ts` + `lib/relogio/executar.ts`.
