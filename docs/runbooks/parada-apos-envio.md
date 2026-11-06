# Runbook — parada do laço depois da última mensagem (`AGENT_STOP_AFTER_FINAL_SEND`)

Hoje, depois de mandar a resposta, o agente chama o modelo **mais uma vez** só
para ele dizer "terminei". Esse passo não produz fato nenhum e, no turno medido em
outubro (luna, com cache), custa ~21,6 mil tokens de entrada: −50% dos tokens do
`agent_turn`, ~0,051¢ por turno que para. Num provedor sem cache o mesmo passo
custa de 1,6¢ a 6,5¢.

O knob `AGENT_STOP_AFTER_FINAL_SEND` faz o laço parar ali — **ligado por
padrão** desde a avaliação deste runbook (aprovada nos modelos medidos; `off`
volta ao laço de sempre).

| Valor | O que acontece |
|---|---|
| `off` | Comportamento de sempre, byte a byte: mesmo schema, mesmo laço. |
| `observe` | O `send_message` ganha o parâmetro `encerra_turno` e a marca vai para o traço do turno (`agent_turn_traces.ferramentas[].encerra_turno`). O laço **não** para. Não é neutro: a descrição do parâmetro pode mudar o comportamento do modelo. Serve à avaliação. |
| `on` (padrão) | Como `observe`, e o laço para depois do passo em que o modelo marcou o envio final — se a trava deixar. |

Vale **só** para resposta a mensagem do cliente (`inbound_turn`). Follow-up,
resposta de caso, rascunho assistido e o "Testar" ficam idênticos em qualquer
valor.

## Quando o laço para (com `on`)

Todas ao mesmo tempo — as três primeiras olhando o último passo, a trava olhando
o turno inteiro:

1. o passo teve só `send_message`;
2. todos os envios voltaram aceitos (`enviada` ou `aceita_aguardando_canal`) e sem
   `aviso` — veto, recusa, bolha que falhou ou foto que faltou voltam ao modelo
   como sempre;
3. o modelo marcou ao menos um envio com `encerra_turno: true`;
4. **a trava**: nenhum corpo que saiu neste turno — em **qualquer** passo, não só
   no último — anuncia uma ação que ainda falta. O modelo manda 2 a 4 mensagens
   seguidas; a promessa do passo 1 sem marca continua devendo a ação quando o
   passo 2 marca uma mensagem neutra.

A trava usa os detectores da cadeia `before_send`
(`lib/agent-engine/agent/parada-apos-envio.ts`, `envioAnunciaAcaoSeguinte`):

| O corpo anuncia… | Libera só se, neste turno… |
|---|---|
| passar para uma pessoa (`detectHumanPromise`, com as `handoff_keywords` do agente) | `request_human_handoff` voltou `ok`, ou um caso foi aberto |
| retorno do assistente ("te chamo amanhã", "retomamos às 9h") | o mesmo acima, ou `schedule_followup` agendou |
| verificar a agenda ("vou ver os horários e já te aviso") | nunca |

É a regra de liberação do `casePromiseGate`, mas vale também com
`cases_enabled = false` — o padrão do clone, em que a promessa passa pela cadeia.

O que a trava **não** cobre, e por isso o padrão é `off`: uma escrita que o
modelo faria depois de marcar "final" sem anunciá-la no corpo (nota, etiqueta,
estágio, `crm_create_lead`, outra mensagem). É o que a avaliação mede.

## A avaliação local (antes de qualquer `on`)

O `observe` em produção não é a prova: no volume medido em outubro, a amostra em
risco levaria ~14 meses. A prova é local, pelo caminho de produção (webhook → worker → turno real),
com cenários feitos para pôr ações em risco. **Gasta tokens reais** — orçamento
estimado ≤ US$ 40, quase todo nos modelos Claude.

### Ambiente

O mesmo da doutrina de QA visual: Supabase local com o `supabase/baseline.sql`,
`scripts/bootstrap-owner.ts`, app (`next build` + `next start`) e worker
(`pnpm worker`) de pé, credencial do provedor cadastrada na tela. O roteiro
**recusa** qualquer destino que não seja local (`.env.local` de checkout de
trabalho aponta para produção).

Cada execução passa por `scripts/provoke-agent-turn.ts`, que cadastra uma chave
real como credencial da organização: `ANTHROPIC_API_KEY` quando existe, senão
`OPENROUTER_API_KEY` (ambiente ou `.env.local`; deixe-a fora do `.env.local` e
exporte só no shell do roteiro, para o worker não a ter como chave da
instalação). Sem nenhuma das duas no ambiente, ele não cadastra nada e o turno
usa as credenciais ativas e validadas da organização — o caminho com provedor
direto: cadastre OpenAI e Anthropic em IA › Provedores e rode o roteiro **sem**
chave exportada. Ele procura a sessão de canal `e2e-radar-session` — passe
`--session <waha_session_name>` se a sua tiver outro nome. O modelo de cada lote
é o do agente **publicado**, não o `--model` dele.

**O canal é um receptor HTTP local, e só ele.** Um servidor de poucas linhas que
responda `POST /api/sendText` com a `key.id` do WAHA, e `WAHA_API_BASE_URL`
apontando para ele — o `executar` recusa endereço que não seja local. **Nunca**
rode a avaliação com um WAHA pareado a um número de verdade: o `preparar`
desliga a proteção anti-banimento do número (warm-up, teto diário, janela de
horário, veto de cópia repetida) e o agente responde a cada execução, centenas
de vezes, de madrugada. Os telefones da avaliação têm DDD 20, que não existe no
Brasil — com o canal errado o envio falha em vez de chegar a alguém —, mas o
número pareado mandaria tudo isso sem proteção.

O envio tem de voltar aceito para a parada valer, então o receptor não pode
recusar: com a sessão fora de `WORKING` a mensagem fica `queued`, o envio volta
`aceita_aguardando_canal` e o job é **reagendado** (um segundo turno pago); com
o receptor respondendo erro, o envio volta `envio_falhou`.

**A conta da OpenRouter precisa de saldo**, e o limite da chave não é o saldo:
`GET /api/v1/key` devolve `limit_remaining` da chave, e só `GET /api/v1/credits`
diz quanto a conta tem (`total_credits − total_usage`). Sem saldo, todo turno
pago volta 402.

### Cenários

| Id | Mensagem do cliente | Preparo do agente | Ação esperada |
|---|---|---|---|
| S0 | Qual o horário de funcionamento? | padrão | — (mede adoção) |
| S1-casos-off | Fui cobrado duas vezes no cartão e quero que alguém da empresa resolva hoje | `cases_enabled` falso, passagem ligada | passagem ou caso |
| S1-casos-on | a mesma | `cases_enabled` verdadeiro | passagem ou caso |
| S2-casos-off | Agora estou dirigindo, me chama amanhã às 10h | `cases_enabled` falso, retorno ligado | follow-up ou caso |
| S2-casos-on | a mesma | `cases_enabled` verdadeiro | follow-up ou caso |
| S3 | Tenho interesse no plano anual… pode registrar meu interesse? | capacidade `crm_create_lead` ligada | `crm_create_lead` |
| S4 | Meu orçamento é de até 5 mil reais e quero fechar ainda este mês | padrão | nota ou estágio |
| S5 | Me explica em detalhes como funciona, quanto custa e as formas de pagamento | `split_messages` falso (padrão) | — (mensagens por turno) |

Os textos exatos estão em `scripts/lib/avaliacao-parada-apos-envio.ts` (`CENARIOS`).

### Execução

K = 20 por cenário × braço (`off`, `observe`) × modelo em uso — a lista sai da
consulta em "Virada e reversão", passo 3, rodada na instalação no dia. Os ids de
cada modelo na OpenRouter vêm de `GET https://openrouter.ai/api/v1/models`. Um
**lote** por modelo: o número do lote
entra no telefone de cada execução, e cada execução é um contato novo.

1. Publique o agente com o modelo do lote e o preparo do cenário. Com
   `--modelo provedor:modelo` (provedor direto: `openai:gpt-5.6-luna`,
   `anthropic:claude-sonnet-4-6`) ou `--modelo <id da OpenRouter>` (sem `:`), o
   `executar` faz isso sozinho antes de cada
   cenário (é o comando `preparar`): agente com as ferramentas que o onboarding
   liga no primeiro agente (pacote `vender`) mais as do cenário, as colunas de
   `CENARIOS[].versao`, e o número sem o que atrapalharia a medição — sessão
   `WORKING`, sem teto de warm-up nem diário, janela de resposta de 24h e o veto
   de cópia repetida desligado (20 execuções da mesma pergunta dão respostas
   parecidas entre contatos, o que nenhum cliente real produz).
2. Ponha `AGENT_STOP_AFTER_FINAL_SEND` do braço no `.env.local` e **reinicie o
   worker** (o knob é lido no boot).
3. Confira o plano (sem rede):

   ```bash
   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts plano \
     --lote 1 --braco observe --k 20 --cenarios S1-casos-off
   ```

4. Rode o lote (uma execução por vez; cada uma espera o job do turno terminar,
   re-tentativas incluídas — a re-tentativa roda com a versão publicada NA HORA,
   e seguir antes dela poria o turno no cenário ou no modelo seguinte):

   ```bash
   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts executar \
     --lote 1 --braco observe --k 20 --cenarios S1-casos-off --teto-usd 2
   ```

   `--teto-usd` é obrigatório: antes de cada execução e depois da última, o
   roteiro soma `llm_calls.cost_cents` dos contatos do lote (e, das chamadas sem
   contato, só as do agente da avaliação desde o início da invocação — o
   sentimento do turno; a prévia da avaliação de tokens rodando junto não entra)
   e para no teto — pode passar dele por uma execução. Chamada do lote com tokens
   e custo nulo ou zero (modelo `:free`, preço que não chegou) para o lote **com
   erro**: o teto estaria cego. O lote vai de 0 a 99 (dois dígitos no telefone).

   Depois de cada execução, e também quando o lote para no meio, o roteiro
   cancela os retornos (`cron_jobs` followup_turn) que os turnos do lote
   agendaram — o S2 agenda de verdade, e o worker os dispararia no dia seguinte
   como turnos pagos fora do teto — e o log diz quantos (`# retornos cancelados
   neste executar: N`). Execução que terminou "SEM TRAÇO no teto" pode agendar
   depois do fim: confira antes de seguir (troque `01` pelo lote, dois dígitos)

   ```sql
   select count(*) from cron_jobs j join contacts c on c.id = j.contact_id
    where j.enabled and j.job_kind = 'followup_turn'
      and regexp_replace(c.phone_number, '\D', '', 'g') ~ '^5520901';
   ```

   Interrompido, retome com `--de <n>`: rodar o mesmo lote de novo recomeça na
   execução 1 e manda a 2ª mensagem a um contato que já tem conversa.
5. Repita para o outro braço e para os demais cenários, trocando o preparo do
   agente quando a tabela pede (ou passando `--modelo`).
6. Custo por execução, da soma de `llm_calls.cost_cents` de cada contato:

   ```bash
   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts custo \
     --desde 2026-11-01T00:00:00Z --lotes 1
   ```

### Relatório e veredito

```bash
pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts relatorio \
  --desde 2026-11-01T00:00:00Z --lotes 1
```

Por modelo × cenário × braço: adoção da marca, execuções em risco (alguma
ferramenta depois do 1º envio aceito), marcou-e-agiu, e para cada marcou-e-agiu
o desfecho da trava aplicada ao corpo enviado — `segurado` (a parada não teria
acontecido), `perda` (teria) ou `revisar` (o corpo do envio marcado não é
identificável: mais de um envio no turno, ou o ledger do job tem mensagem além da
do único envio — bolha, template, pergunta do roteiro; conta como perda até alguém
olhar os jobs listados).

Todo erro do relatório cai do lado da perda: a liberação da trava conta tudo o
que a produção conta, inclusive o caso que o fail-safe abre sozinho
(`agent_cases.source = 'guardrail_autofallback'`), que não aparece no traço como
ferramenta.

**Aprova** um modelo quando as três valem:

- **(a)** 0 perdas efetivas (e 0 a revisar) em **≥ 80 execuções em risco** no
  braço `observe` — limite superior de 95% ≤ 3,7%. Abaixo de 80 o veredito é
  `INCONCLUSIVO`: aumente K ou leve o limite obtido ao dono.
- **(b)** a taxa da ação esperada no `observe` fica ≥ à do `off` menos a tolerância
  (padrão 2/20 = 0,10 por cenário; `--tolerancia`), e as mensagens por turno do S5
  não caem.
- **(c)** a adoção (S0) é registrada — não reprova, dimensiona o ganho.

A consulta crua, para conferir o relatório à mão:

```sql
with x as (
  select t.id, t.model, j.kind, o, f
    from agent_turn_traces t
    join job_queue j on j.id = t.job_id,
         jsonb_array_elements(t.ferramentas) with ordinality y(f, o)
   where not t.is_dry_run and t.created_at >= :'inicio'),
e as (
  select id,
         min(o) filter (where f->>'nome' = 'send_message' and f->>'estado' = 'ok') p1,
         min(o) filter (where f->>'nome' = 'send_message' and f->>'estado' = 'ok'
                          and f->>'encerra_turno' = 'true') pf,
         max(o) ult
    from x group by id)
select x.model, x.kind,
       count(distinct e.id)                                  turnos,
       count(distinct e.id) filter (where e.p1 < e.ult)      em_risco,
       count(distinct e.id) filter (where e.pf < e.ult)      marcou_final_e_agiu,
       count(distinct e.id) filter (where e.pf is not null)  adocao,
       string_agg(distinct x.f->>'nome', ',') filter (where x.o > e.pf) acoes_apos_final
  from e join x on x.id = e.id
 group by 1, 2;
```

## Virada e reversão

1. Deploy com `off` — nada muda.
2. Avaliação local acima, por modelo.
3. `on` na instalação só quando **todos** os modelos em uso nos agentes da instalação
   estiverem aprovados. O knob é global no worker — não há recorte por modelo
   (uma allowlist por modelo é trabalho futuro). Os modelos em uso:

   ```sql
   select distinct v.provider, v.model
     from ai_agents a join ai_agent_versions v on v.id = a.published_version_id
    where a.archived_at is null;
   ```

   Para contar as paradas, procure no
   log do worker a linha `laço encerrado após envio final declarado`; para a
   economia, a mediana diária de `llm_calls.input_tokens` do `agent_turn` nos
   turnos cujo último item do traço é um `send_message` com `encerra_turno`
   (esperado perto de 21,6 mil, contra 43,2 mil antes).
4. **Reversão**: `AGENT_STOP_AFTER_FINAL_SEND=off` no `.env` e reinicie o worker
   (`docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d worker`
   numa VPS com proxy próprio). Reverta na hora se aparecer item `promise_unfulfilled`
   ou `case_stale` atribuível, ou se as escritas por turno caírem além do limiar do
   dono frente aos 30 dias anteriores. Com `on`, a perda por marca errada é
   invisível por construção — o monitoramento depois da virada é alarme, não prova.

O padrão da release só vira `on` por decisão do dono, com fragmento próprio.
