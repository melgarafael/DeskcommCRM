# Follow-up barrado não fala com o cliente — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** um texto do follow-up barrado pela trava de valores e negociação só não sai (sem aviso ao cliente, sem passar a conversa) quando o cliente não tem mensagem esperando resposta, e todo envio barrado registra a trava, o trecho que a acionou e o texto.

**Architecture:** a régua é `inboundsNaoRespondidos` (já existe) dentro do turno do agente; a trava comercial passa a devolver o trecho que casou; a linha `send_vetoed` (já existe) recebe texto e trecho; a automação `send_ai_message` reescreve uma vez em vez de passar à equipe; um código de motivo novo dá ao cartão a frase certa.

**Tech Stack:** Next.js 16, TypeScript estrito, Postgres (Supabase), vitest (`pnpm test:unit`, `pnpm test:db`).

**Spec:** `docs/specs/34-spec-followup-barrado-nao-fala-com-o-cliente.md` (medições B1–B10, código C1–C22, decisões D1–D4). Ler a spec antes de cada task.

## Global Constraints

- Base: branch nova a partir de `origin/main` (`95f3103d1` ou mais nova), nome `fix/followup-barrado-nao-fala-com-o-cliente`.
- **Nenhum teste roda nesta máquina** (regra do Paulo): nada de vitest, `pnpm test:*` nem Docker. Todo passo "verificar" é: commit, push na branch do fork, ler o job do CI (`verify` para unit, `invariants` para `tests/invariants`). Local só `pnpm typecheck` e `pnpm lint`.
- Sabotagem é obrigatória em toda task com teste: reverter só a linha do conserto, prever quantos casos caem, empurrar, conferir no CI, restaurar. Registrar "N vermelhos de M, o previsto" no corpo do PR.
- O rastro da cadeia (`before_send_traces.trace`, `detail` dos gates, log) continua **sem corpo e sem trecho** (C7). Texto e trecho vão **só** na linha `send_vetoed` de `crm_lead_activities`.
- Toda consulta com service role filtra `organization_id`. Nenhum `console.log`.
- Schema = migration (número por `pnpm checar:colisao-de-migration`) + linha `-- manifest:` + baseline + nada em `MANIFEST.md`.
- Fragmento `.changes/followup-barrado-nao-fala-com-o-cliente.md` com `impacto: capacidade_nova` (a linha "Não enviei" passa a dizer o trecho) e `secao: corrigido`. Nunca escrever seção no `CHANGELOG.md`.
- Frases fixas (copiar literal):
  - `F_COMERCIAL` = `Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe`
  - sufixo do trecho = ` (o texto tinha "<trecho>")`
  - `F_COM_EQUIPE` = `Não enviei: a conversa está com a equipe`
  - erro ao agente, 1º veto sem pendência = `Este texto não foi enviado porque toca em valores ou negociação, que são só com a equipe. Reescreva sem esse assunto, ou termine sem enviar. O cliente não está esperando resposta: não passe a conversa para a equipe.`
  - erro ao agente, 2º veto sem pendência = `O texto foi barrado de novo por tocar em valores ou negociação. Termine o turno sem enviar mensagem.`
  - frase do motivo novo = `A trava de valores e negociação barrou a resposta`

## Review Focus

1. **Rajada: cliente responde enquanto o follow-up roda.** `inboundsPendentes` é lido na abertura do turno; se a mensagem chegou depois, o turno trata como "sem pendência" e não avisa. Esperado: aceitável (o turno de resposta dessa mensagem vem logo atrás). Teste: Task 3, caso (e) — mensagem nova gravada depois da abertura não muda o desfecho do turno do follow-up, e nenhum aviso sai.
2. **Mensagem do cliente só com mídia (corpo vazio).** `inboundsNaoRespondidos` ignora corpo vazio, então foto sem legenda conta como "sem pendência". Esperado: foto sem resposta **é** pendência para esta régua. Teste: Task 3, caso (f) — inbound com `body = ''` e mídia depois da última saída → avisa e passa, como (c).
3. **Trava desligada.** Com a camada desligada nada disso pode disparar: o texto com preço sai. Teste: Task 3, caso de controle (camada desligada → o texto sai, sem linha `send_vetoed`).
4. **Trecho com dado pessoal ou longo.** O trecho é recortado do texto normalizado e limitado a 40 caracteres. Teste: Task 1, `trechoComercialNaSaida` nunca devolve mais de 40 caracteres.
5. **Execução antiga da automação com `commercial_requires_human_sem_passagem`.** A tela ainda tem de traduzir execuções gravadas antes da mudança. Teste: Task 4, a chave continua no dicionário de `ActivityTab.tsx`.

---

### Task 1: A trava comercial devolve o trecho que a acionou

**Files:**
- Modify: `lib/escalacao/assunto-comercial.ts:15-68`
- Test: `tests/unit/trecho-comercial-na-saida.test.ts` (novo)

**Interfaces:**
- Produces: `trechoComercialNaSaida(texto: string): string | null` (exportada). `contemAssuntoComercialNaSaida(texto)` continua com a mesma assinatura e passa a ser `trechoComercialNaSaida(texto) !== null`. `contemAssuntoComercialRestrito` não muda de comportamento.

- [ ] **Step 1: Escrever o teste que falha**

```ts
import { describe, expect, it } from "vitest";
import { contemAssuntoComercialNaSaida, trechoComercialNaSaida } from "@/lib/escalacao/assunto-comercial";

describe("trechoComercialNaSaida", () => {
  it.each([
    ["Pode ficar tranquilo, é sem custo nenhum", "custo"],
    ["Sai por R$ 99 no plano", "r$ 99"],
    ["Dá para pagar em 3x no cartão", "pagar"],
    ["Parcelamos em 3x", "parcelamos"],
    ["Tudo grátis no primeiro mês", "gratis"],
  ])("%s → %s", (texto, trecho) => {
    expect(trechoComercialNaSaida(texto)).toBe(trecho);
  });
  it("texto sem assunto comercial → null", () => {
    expect(trechoComercialNaSaida("Bom dia! Conseguiu ver o diagnóstico do seu site?")).toBeNull();
  });
  it("nunca passa de 40 caracteres", () => {
    expect((trechoComercialNaSaida("r$ " + "9".repeat(80)) ?? "").length).toBeLessThanOrEqual(40);
  });
  it("concorda com contemAssuntoComercialNaSaida", () => {
    for (const t of ["sem custo", "oi tudo bem", "valor", "15.10 às 14.30"]) {
      expect(trechoComercialNaSaida(t) !== null).toBe(contemAssuntoComercialNaSaida(t));
    }
  });
});
```

- [ ] **Step 2: Typecheck local falha** — `pnpm typecheck` → erro "has no exported member 'trechoComercialNaSaida'".

- [ ] **Step 3: Implementar**

Transformar o `||` de `contemAssuntoComercialRestrito` numa lista `PRECO_NA_ENTRADA: readonly RegExp[]` (mesmas regex, mesma ordem); `contemAssuntoComercialRestrito` = `PRECO_NA_ENTRADA.some(...)` sobre o texto normalizado. `trechoComercialNaSaida` percorre `[...PRECO_NA_ENTRADA, ...PRECO_SO_NA_SAIDA]` em ordem e, na primeira que casar, devolve o texto normalizado do início do casamento até o fim da palavra em que o casamento termina (`\S*` à direita), com `trim()` e corte em 40 caracteres. Os casos do Step 1 fixam a ordem: se algum caso falhar por ordem, a ordem das regex é a da `main`, e o caso esperado é o que muda (anotar no PR).

- [ ] **Step 4: Commit, push, verificar** — job `verify` do CI: o arquivo novo verde e nenhum teste vermelho a mais.

- [ ] **Step 5: Sabotar** — fazer `trechoComercialNaSaida` devolver o casamento sem estender até o fim da palavra → previsto: 1 vermelho (`r$ 99` vira `r$ 9`). Restaurar.

```bash
git add lib/escalacao/assunto-comercial.ts tests/unit/trecho-comercial-na-saida.test.ts
git commit -m "feat(trava-comercial): a trava diz qual trecho do texto a acionou"
```

---

### Task 2: A linha "Não enviei" diz a trava, o trecho e guarda o texto

**Files:**
- Modify: `lib/leads/veto-activity.ts` (`VetoActivityInput`, `emitVetoActivity`, `vetoReason`)
- Modify: `lib/agent-engine/guardrails/before-send.ts:1866-1880` (chamada de `emitVetoActivity` no ramo do veto)
- Test: `tests/unit/veto-activity-motivo.test.ts` (novo); `tests/invariants/veto-grava-texto-e-trecho.test.ts` (novo, molde `tests/invariants/restricao-comercial-no-send-template.test.ts`); `tests/invariants/lgpd-cascata-alcanca-a-passagem.test.ts` (acrescentar caso)

**Interfaces:**
- Consumes: `trechoComercialNaSaida` (Task 1).
- Produces: `VetoActivityInput` ganha `textoBarrado?: string` e `trecho?: string | null`; `vetoReason(gate: string, code: string, trecho?: string | null): string`; `payload` da linha = `{ gate, code, texto_barrado?, trecho? }` (chaves ausentes quando o valor não veio).

- [ ] **Step 1: Teste unit do motivo**

```ts
expect(vetoReason("commercial_restriction", "commercial_requires_human", "sem custo"))
  .toBe('Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe (o texto tinha "sem custo")');
expect(vetoReason("commercial_restriction", "commercial_requires_human", null))
  .toBe("Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe");
expect(vetoReason("stop", "atendimento_com_humano")).toBe("Não enviei: a conversa está com a equipe");
expect(vetoReason("stop", "opted_out")).toBe("Não enviei: o contato pediu para parar de receber mensagens");
```

(Confirmar o código real do opt-out no `stopGate` e usar o literal certo no último caso.)

- [ ] **Step 2: Teste de invariante** `veto-grava-texto-e-trecho.test.ts` — org com a camada comercial ligada, contato com negócio aberto, `runBeforeSend` com corpo `"Fica sem custo nenhum"`:
  - linha `crm_lead_activities` `type = 'send_vetoed'` com `payload->>'texto_barrado' = 'Fica sem custo nenhum'`, `payload->>'trecho' = 'custo'`, `reason` = `F_COMERCIAL` + sufixo;
  - `before_send_traces.trace::text` **não** contém `custo` nem o corpo (C7);
  - mais dois casos com `"Sai por R$ 99"` (trecho `r$ 99`) e `"Parcelamos em 3x"`.

- [ ] **Step 3: Caso LGPD** em `lgpd-cascata-alcanca-a-passagem.test.ts` — depois de anonimizar o contato, a linha `send_vetoed` tem `payload` e `reason` vazios (C19 já faz; o teste prende).

- [ ] **Step 4: Implementar** — `vetoReason` com o ramo `commercial_restriction` e o ramo `stop` + `code === 'atendimento_com_humano'` antes do mapa por gate. Em `before-send.ts`, no ramo do veto, passar `textoBarrado: ctx.body` e `trecho: veto.gate === 'commercial_restriction' ? trechoComercialNaSaida(ctx.body) : null`. Nada muda em `persistTrace` nem no `detail` do gate.

- [ ] **Step 5: Commit, push, verificar** — jobs `verify` e `invariants` verdes.

- [ ] **Step 6: Sabotar** — não passar `trecho` em `before-send.ts` → previsto: os 3 casos do Step 2 vermelhos. Tirar `payload` da cascata de LGPD numa cópia local do teste não vale; sabotar comentando o `texto_barrado` no payload → Step 2 vermelho. Restaurar.

```bash
git add lib/leads/veto-activity.ts lib/agent-engine/guardrails/before-send.ts tests/unit/veto-activity-motivo.test.ts tests/invariants/veto-grava-texto-e-trecho.test.ts tests/invariants/lgpd-cascata-alcanca-a-passagem.test.ts
git commit -m "feat(veto): a linha Não enviei diz a trava, o trecho e guarda o texto barrado"
```

---

### Task 3: No turno, veto comercial sem mensagem pendente só não envia

**Files:**
- Modify: `lib/agent-engine/agent/inbound-turn.ts` — `passarComercialParaEquipe` (`:3271`), ramos de `send_message` (`:4409`) e `send_template` (`:5013`), `request_human_handoff` (perto de `:5405`) e `open_human_case` (perto de `:5592`)
- Test: `tests/invariants/restricao-comercial-no-followup.test.ts` (novo, harness de `restricao-comercial-no-send-template.test.ts`)

**Interfaces:**
- Consumes: `inboundsPendentes` (já calculado em `:3308` a partir de `inboundsNaoRespondidos`).
- Produces: nada exportado. Estado local do turno: `vetosComerciaisSemPendencia: number` e o código de erro `handoff_bloqueado_apos_veto_comercial` devolvido pelas duas ferramentas.

- [ ] **Step 1: Teste que falha** — todos `followup_turn`, camada ligada, modelo fake chamando `send_message` com `"Fica sem custo nenhum"`:
  - (a) contato sem nenhuma mensagem de entrada → 0 mensagens novas em `messages`, 0 itens `handoff` na Central, `contacts.force_human = false`, passo do fluxo `skipped`, erro devolvido ao modelo = a frase do 1º veto;
  - (b) mensagem do cliente já respondida (saída depois dela) → igual a (a);
  - (c) mensagem do cliente sem resposta → aviso de passagem sai e `force_human = true` (como hoje);
  - (d) igual a (a), e o modelo chama depois `open_human_case` e `request_human_handoff` → as duas devolvem `handoff_bloqueado_apos_veto_comercial`, nenhum caso aberto, nenhum aviso, `force_human = false`;
  - (e) igual a (a), com uma mensagem do cliente gravada depois da abertura do turno → nenhum aviso neste turno;
  - (f) mensagem do cliente só com mídia (`body = ''`) sem resposta → igual a (c);
  - (g) modelo tenta 3 vezes com preço → 2ª devolve a frase do 2º veto, a 3ª não chama a cadeia (só 2 linhas `send_vetoed`);
  - controle: camada desligada → o texto sai.
  - O teste de `inbound_turn` já existente (C12) não muda.

- [ ] **Step 2: Implementar**
  - Pendência = `inboundsPendentes.length > 0` **ou** existe inbound de mídia depois da última saída (caso f). Se `inboundsNaoRespondidos` for a origem do problema de (f), criar `temMensagemDoClienteSemResposta(messages): boolean` ao lado dela em `inbound-turn.ts` e usar só aqui (não mudar `inboundsNaoRespondidos`, que alimenta opt-out e urgência).
  - Com pendência: `passarComercialParaEquipe` como hoje.
  - Sem pendência: incrementa `vetosComerciaisSemPendencia` e devolve `{ ok: false, error: { code, message } }` com a frase do 1º ou do 2º veto. Com o contador já em 2, `send_message`/`send_template` com corpo que `contemAssuntoComercialNaSaida` devolvem a frase do 2º veto sem chamar a cadeia.
  - Com `vetosComerciaisSemPendencia > 0`, `open_human_case` e `request_human_handoff` devolvem `{ ok: false, error: { code: 'handoff_bloqueado_apos_veto_comercial', message: 'O cliente não está esperando resposta e o texto foi barrado por valores ou negociação: não passe a conversa. Termine sem enviar.' } }` antes de qualquer efeito.
  - O passo do fluxo fica `skipped` sozinho (C15: sem linha aceita no `send_ledger`). Não mexer em `followup-turn.ts`.

- [ ] **Step 3: Commit, push, verificar** — job `invariants`: arquivo novo verde, `restricao-comercial-no-send-template.test.ts` verde.

- [ ] **Step 4: Sabotar** — (1) trocar a condição por "sempre tem pendência" → previsto vermelhos: a, b, d, e, g (5); c, f e controle verdes. (2) "nunca tem pendência" → vermelhos: c, f e o teste de `inbound_turn`. (3) tirar a trava das duas ferramentas → vermelho: d. Restaurar.

```bash
git add lib/agent-engine/agent/inbound-turn.ts tests/invariants/restricao-comercial-no-followup.test.ts
git commit -m "fix(follow-up): texto barrado pela trava comercial sem cliente esperando só não sai"
```

---

### Task 4: Automação `send_ai_message` barrada reescreve uma vez e não passa à equipe

**Files:**
- Modify: `lib/automation/actions/send-ai-message.ts:150-265`
- Modify: `lib/agent-engine/agent/abordagem-de-formulario.ts` (`AbordagemDeFormularioInput`, montagem das mensagens a partir de `:234`)
- Modify: `app/app/webhooks/_components/ActivityTab.tsx:203-210`
- Modify: `docs/specs/atendimento-comercial.md:15`
- Test: `lib/automation/actions/send-ai-message-restricao-comercial.test.ts`

**Interfaces:**
- Consumes: `trechoComercialNaSaida` (Task 1).
- Produces: `AbordagemDeFormularioInput.tentativaBarrada?: { texto: string; trecho: string | null }` — quando presente, entra no prompt uma linha: `A primeira versão não pôde ser enviada porque tocava em valores ou negociação (trecho: "<trecho>"). Escreva de novo sem falar de valores, preço, custo, condições ou gratuidade.`

- [ ] **Step 1: Teste que falha** (no arquivo existente, gerador fake):
  - 1ª barrada, 2ª limpa → a 2ª é enviada, `triggerHandoff` não é chamado, `detail.veto_anterior = { texto_barrado, trecho }`, `detail.texto_gerado` = a 2ª;
  - as duas barradas → nada enviado, `status: 'skipped'`, `detail.reason = 'commercial_requires_human'`, `detail.textos_barrados` com as 2, `detail.trecho` da 2ª, gerador chamado exatamente 2 vezes, `triggerHandoff` não chamado;
  - `ActivityTab`: a chave `commercial_requires_human_sem_passagem` continua no dicionário (execuções antigas) e a frase de `commercial_requires_human` não diz mais que a conversa passou para a equipe.

- [ ] **Step 2: Implementar** — tirar a chamada de `triggerHandoff` deste ramo; gerar de novo com `tentativaBarrada`; frase nova de `commercial_requires_human` em `ActivityTab.tsx`: `Esta empresa deixou valores e negociação só com a equipe, e a mensagem escrita pela IA falava disso nas duas tentativas: nada foi enviado, e a conversa continua com a IA. O trecho barrado aparece no detalhe desta execução.` Atualizar `docs/specs/atendimento-comercial.md:15` para dizer que a automação reescreve uma vez e não passa a conversa.

- [ ] **Step 3: Commit, push, verificar** — job `verify` verde.

- [ ] **Step 4: Sabotar** — (1) devolver o `triggerHandoff` → previsto: 2 vermelhos (os dois casos de envio). (2) tirar a 2ª geração → vermelho: o caso "1ª barrada, 2ª limpa". Restaurar.

```bash
git add lib/automation/actions/send-ai-message.ts lib/agent-engine/agent/abordagem-de-formulario.ts app/app/webhooks/_components/ActivityTab.tsx docs/specs/atendimento-comercial.md lib/automation/actions/send-ai-message-restricao-comercial.test.ts
git commit -m "fix(automacao): mensagem da IA barrada por valores reescreve uma vez e não passa à equipe"
```

---

### Task 5: O cartão da passagem diz que foi a trava comercial

**Files:**
- Create: `supabase/migrations/<timestamp>_<NNNN>_motivo_restricao_comercial_na_passagem.sql`
- Modify: `supabase/baseline.sql` — o bloco **único** de `passagens_de_atendimento_motivo_codigo_check` (`:30436-30440`) recebe o valor, mais um comentário no fim do arquivo no molde do de `verificacao_manual` (`:76671`)
- Modify: `lib/escalacao/passagem.ts:83-145` (`MOTIVOS_DA_PASSAGEM`, `FRASE_DO_MOTIVO`)
- Modify: `lib/ai/handoff/orchestrator.ts:56` (`HandoffReason`) e o mapa `MOTIVO_DA_PASSAGEM`
- Modify: `lib/agent-engine/agent/inbound-turn.ts` — `passarComercialParaEquipe` (`:3276-3282`) e `escalarComercialAntesDoModelo` (`:2455-2466`)
- Modify: `lib/i18n/traducoes/en.json`, `tr.json`, `zh-CN.json` (a chave da frase nova, onde hoje existe a de `low_confidence`)
- Test: `tests/invariants/vocabulario-banco-x-typescript.test.ts`, `tests/unit/passagem-motivo-em-portugues.test.ts` (já cobrem; conferir que pegam o valor novo)

**Interfaces:**
- Produces: `MotivoDaPassagem` inclui `"restricao_comercial"`; `FRASE_DO_MOTIVO.restricao_comercial = "A trava de valores e negociação barrou a resposta"`.

- [ ] **Step 1: Número da migration** — `pnpm checar:colisao-de-migration` e usar o número livre que ele indicar. Cabeçalho: `-- manifest: motivo restricao_comercial na passagem — o cartão dizia "não teve confiança" quando quem barrou foi a trava de valores (Spec 34)`. Corpo: bloco `do $$` que solta e recria `passagens_de_atendimento_motivo_codigo_check` com a lista inteira + `restricao_comercial` (idempotente, sem BEGIN/COMMIT).
- [ ] **Step 2: Baseline** — acrescentar `'restricao_comercial'` no bloco único (não criar segundo bloco: `tests/unit/baseline-constraint-reconstruida.test.ts` reprova).
- [ ] **Step 3: TypeScript** — o código em `MOTIVOS_DA_PASSAGEM`, `FRASE_DO_MOTIVO`, `HandoffReason` e no mapa; trocar `motivoCodigo: 'low_confidence'` e `reason: 'low_confidence'` pelos dois lugares do turno (o terceiro, a automação, saiu na Task 4). Chave nas 3 traduções.
- [ ] **Step 4: Commit, push, verificar** — `verify` e `invariants` verdes; `vocabulario-banco-x-typescript` compara o CHECK novo com a lista.
- [ ] **Step 5: Sabotar** — tirar `restricao_comercial` do baseline → previsto: `vocabulario-banco-x-typescript` vermelho. Restaurar.

```bash
git add supabase/migrations/*_motivo_restricao_comercial_na_passagem.sql supabase/baseline.sql lib/escalacao/passagem.ts lib/ai/handoff/orchestrator.ts lib/agent-engine/agent/inbound-turn.ts lib/i18n/traducoes/
git commit -m "feat(passagem): o cartão diz que foi a trava de valores, não falta de confiança"
```

---

### Task 6: Prova na tela, fragmento e PR interno

**Files:**
- Create: `.changes/followup-barrado-nao-fala-com-o-cliente.md`
- Create: `evidence/followup-barrado/` (prints)
- Modify: `docs/testing/user-journey-map.md` (linha da jornada)

- [ ] **Step 1: Fragmento** — `impacto: capacidade_nova`, `secao: corrigido`, título: `Follow-up barrado pela trava de valores não avisa o cliente nem pausa a conversa`. Parágrafo para o operador: o que deixa de acontecer e onde ver o trecho barrado (Análise › Atividades).
- [ ] **Step 2: Prova pela tela** — banco fresco do `baseline.sql` + `bootstrap-owner`, envs opcionais ausentes: fluxo de follow-up cujo passo pede um texto com "sem custo", trava ligada, contato sem resposta. Esperado: nenhuma mensagem nova na conversa, nada na Central, automático não pausado, linha "Não enviei: … (o texto tinha \"custo\")" em Análise › Atividades. Prints em `evidence/followup-barrado/`. Se o ambiente de tela não existir, declarar no PR "prova de tela fica com o mantenedor".
- [ ] **Step 3: Pré-voo** — `bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh`; resolver o que ele apontar.
- [ ] **Step 4: PR interno no fork** — corpo com: o que muda para quem usa, as sabotagens ("N vermelhos de M, o previsto") de cada task, e o bloco "O que NÃO medi". Só depois do verde do CI do fork, o PR ao Rafael, assinado "— Paulo Lima Jr".

```bash
git add .changes/followup-barrado-nao-fala-com-o-cliente.md evidence/followup-barrado docs/testing/user-journey-map.md
git commit -m "docs: prova de tela e fragmento do follow-up barrado"
```

---

## Fora deste plano

- Fatia 4 da spec (aba Teste simulando follow-up): recurso novo, plano próprio.
- P1 (contato sem negócio aberto) e P2 (`clinical_claim`, `case_promise`): ficam como estão até o mantenedor responder.
