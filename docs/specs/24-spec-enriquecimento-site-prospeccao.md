---
title: "Spec Técnica 24 — Enriquecimento de site na prospecção (auditoria + estratégia + prompt por lead)"
parent: 00-prd-master.md
type: spec
scope: prospecção
status: draft
version: 1.0.0
owner: arquitetura
created_at: 2026-10-10
related:
  - 07-spec-events-workers.md
  - 10-spec-ai-agents-runtime.md
  - 13-spec-governanca-atendimento.md
  - 17-spec-conversa-vira-lead.md
---

# Spec 24 — Enriquecimento de site na prospecção

> Quando a busca do Maps devolve um candidato com `website`, hoje o produto trata "tem site" como fato binário — e a fila de abordagem não sabe se é site bom, ruim, morto ou um link de Instagram colado no campo errado. Esta spec adiciona o **enriquecimento de site**: classificar o `website` de cada candidato (agregador / sem HTTPS / SSL inválido / fora do ar / não-mobile / lento / construtor pronto / ok), guardar o raio-X em `data`, mostrar a **auditoria inline** no card do lead, ordenar por **score com 4ª categoria** e alimentar a abordagem fria com **estratégia + prompt por situação, oferta e nicho**. Sem PDF, sem Python, sem container novo, sem Instagram não-oficial.

---

## 1. Por que existe (medições que a sustentam)

Todas as medições abaixo foram refeitas em 2026-10-10; cada número traz o comando que o produziu. Medição sem comando é relato.

### 1.1 O campo `website` vem poluído — medido na VPS de produção

```bash
# ranking de campanhas (só contagem, sem PII)
Get-Content rank.sql | ssh appfin-staging "docker exec -i supabase-db psql -U postgres -d postgres -tA"
# => 59914589-...|669eb15e-...|99|71   (maior campanha: 99 candidatos, 71 "com site")

# 20 websites distintos da maior campanha (só o campo website, sem telefone/nome)
Get-Content sites.sql | ssh appfin-staging "docker exec -i supabase-db psql -U postgres -d postgres -tA"
```

Spike de fetch executado **de dentro da VPS** (`docker exec -i deskcomm-worker-1 node --input-type=module`, Node v22.23.3, timeout 8s, redirects seguidos):

| Classe | Qtd/20 | Detalhe medido |
|---|---|---|
| `agregador` | 8 | 5× `instagram.com`, 1× `linktr.ee`, 1× `forms.gle`, 1× `api.whatsapp.com` — classificado só pelo host, zero fetch |
| `site-ok` | 7 | HTTP 200 sem problemas (51–841ms) |
| `site-ruim` | 4 | 3× construtor Wix (`static.wixstatic.com` + `parastorage` + `generator`), 1× `http-404` + sem-viewport + quase-vazia (link `automatizo.dev.br` morto) |
| `ssl-invalido` | 1 | `DEPTH_ZERO_SELF_SIGNED_CERT` em URL `http://` que redireciona para HTTPS com cert autoassinado |

Conclusão `CONFIRMADA`: 40% do que a busca chama de "com site" **não é site próprio**. Qualquer score ou filtro que leia `website` como booleano mente em 4 de cada 10. O filtro de agregador (lista de domínios, sem rede) precisa rodar **antes** de qualquer fetch.

### 1.2 Classificação 100% TS funciona no worker real — medido

* `fetch` + `AbortSignal.timeout(8000)` distingue os 3 erros que o sistema de referência (ProspectOS, Python) separava na mão: `ENOTFOUND` = DNS-morto definitivo em ~70ms (sem retry); `CERT_*`/`DEPTH_ZERO_SELF_SIGNED_CERT` = SSL inválido em ~500ms; timeout/conexão recusada = fora do ar.
* `http://` final após redirects = sem HTTPS; ausência de `viewport` = não-mobile; `<800` chars = quase-vazia; assinaturas de URL+HTML = construtor pronto.
* 6 fetches em paralelo: wall 700ms contra ~580ms cada (speedup ~5×), `+19MB` RSS — cabe no teto do worker (`docker-compose.prod.yml`: 512m; medido em produção: worker 245/512MiB, app 299/768MiB, host 16GB, disco 19%).
* Calibragens que o spike expôs (viram casos de teste, §7): `example.com` cai em "quase-vazia" (limiar precisa de exceção para páginas mínimas válidas); `wix.com` trigou 3 assinaturas Wix de uma vez (deduplicar para um rótulo); `http://neverssl.com` deu timeout nesta rede — a regra "tenta HTTPS, sem DNS-morto tenta HTTP puro" precisa de re-medição em staging antes de virar definitiva.

### 1.3 Onde o enriquecimento mora hoje — medido no código

* `lib/prospecting/schema.ts:98` `Prospect`: 11 chaves (`key,name,phone,website,category,address,maps_url,rating,reviews,emails,socials`). Confirmado no banco: `jsonb_object_keys(data)` × 99/99 na maior campanha — o `website` poluído com social passa pelo `normalizeProspect` (`schema.ts:113`), que separa `socials` de campos próprios mas **não filtra** o `website`.
* Inserção: `lib/prospecting/store.ts:196` (`normalizeProspect` → `insert ... on conflict do nothing`).
* Tick: `app/api/v1/cron/prospecting/route.ts:17` → `tickProspecting` (`worker.ts:362`: 20 orgs/tick, deadline 180s, lock por org) → `synchronizeSearch` + `sendNextCandidate`.
* Abordagem fria: `gerarAbordagemDeFormulario` (`lib/agent-engine/agent/abordagem-de-formulario.ts:46`) recebe `dados: Record<string,string>` como prosa rotulada (teto `MAX_CAMPOS 40`/`MAX_VALOR 500`) e usa o agente publicado em modo automático — o contexto de site entra ali, sem SDK novo, via `resolveLanguageModel()` (`lib/ai/gateway.ts:61`).
* Chaves de IA presentes na VPS (nomes, nunca valores): `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_*` em app e worker. Não existem `PAGESPEED`/`GEMINI`/`GROQ`/`NVIDIA` — PageSpeed entra como chave opcional **por organização**, não env (decisão §3.5).
* RLS: `tests/invariants/prospecting.test.ts:11` prova 3 tabelas com RLS e zero grant a `anon`/`authenticated`; dedup `unique (organization_id, place_id)` + telefone único por org.
* Navegação: `/app/prospecting` já é porta declarada (`lib/navigation/catalogo.ts:140`, grupo crm, `minRole admin`, fora do sidebar por limite de espaço) — o painel de auditoria **não cria porta**.
* E2E: `git show origin/main:.github/workflows/e2e.yml` → 6 partes (`parte: [1..6]`), `FORA_DO_CI` com 6 specs, **nenhuma spec cobre prospecção** (`grep prospec tests/e2e` vazio) — esta mudança exige spec e2e nova + registro no teste de cobertura (`tests/unit/e2e-cobertura-completa.test.ts`).
* `gov:verify` = `typecheck + lint + lint:channels + lint:role-rank + test:unit` (medido via `node -e` no `package.json`); `origin/main = 048c94b04`; próxima spec livre = **24** (`ls docs/specs`: 01–20 e 23 ocupadas); migration mais nova `20261005090000_0543` (número novo só no PR, com `pnpm checar:colisao-de-migration`).

### 1.4 Estado da fila que justifica a prioridade — medido

Maior campanha: `sent 50 / queued 29 / skipped 20`; 95 com contato, 97 com lead, 95 com conversa. Ou seja: metade da fila **já foi abordada sem auditoria de site**, e 29 ainda esperam — o painel tem valor imediato para o operador decidir retomada, e o enriquecimento no momento da busca impede repetir o ponto cego.

---

## 2. Decisão de destino (núcleo, não extensão)

Pergunta-raiz: *se nenhuma organização ativar isto, a operação comum continua inteira?* Não — busca, fila, score e abordagem fria são o núcleo de prospecção que já existe (`app/api/v1/prospecting/route.ts`). Logo é **PR no núcleo**. Não é extensão declarativa (formato atual: só cards, sem código/dado/tela/ferramenta de IA; `HOST_API_VERSION = 2` em `lib/extensions/manifest.ts:120`) e não cria módulo com tabela (ADR-0002 não construída).

---

## 3. Desenho

### 3.1 Contrato de dados — zero migration

Tudo mora em `prospecting_candidates.data` (JSONB que já existe), mesclado com `data || '{"site":...}'` + `updated_at=now()`. Nenhuma tabela nova, nenhuma coluna nova, nenhuma policy nova — o invariante de banco já cobre tudo. Ausência de `data.site` = não enriquecido (retomável por definição).

```ts
// data.site — escrita só pelo worker de enriquecimento, lida pela tela e pela abordagem
interface SiteEnrichment {
  ver: 1;
  classe: "agregador" | "sem-site" | "site-ok" | "site-ruim" | "ssl-invalido" | "fora-do-ar";
  // "sem-site": website nulo/vazio (nunca faz fetch)
  problemas: string[];      // ex: ["sem-https","nao-mobile","construtor-Wix"] — vocabulário fechado (§3.3)
  checklist: { tem: string[]; falta: string[] };  // raio-X: whatsapp,tel,mailto,social,mapa,fotos,titulo,description,favicon
  final_url: string | null; // URL após redirects (máx 500)
  http_status: number | null;
  tempo_ms: number;         // TTFB+leitura (teto 8000)
  conteudo_resumo: string | null; // título + h1/h2 + trecho, máx 1200 chars — o que a copy pode citar
  pagespeed: { nota: number; lcp: string | null; medida_em: string } | null; // best-effort, §3.5
  verificado_em: string;    // ISO-8601 UTC
}
```

* `prospectEnrichmentSchema` (`schema.ts:155`) é o portão do que o painel pode exibir (`crm-summary` valida e o `LeadEnrichment` só renderiza o validado): `site` entra ali como sub-schema opcional, ou o Zod fatia a chave e o painel nunca a vê. Nada de endpoint novo.
* Retenção herdada: `data.site` mora na linha do candidato, logo cai no expurgo de 365d do `data-retention` junto com o resto (sem purge própria). E lição da BrasilAPI (`enrich.ts:semSocios`): não guardar PII sem finalidade — o resumo leva só texto público da página (título/cabeçalhos/trecho), nunca quadro societário ou documento de pessoa.

`classe` deriva de regra determinística (função pura, testável sem rede): agregador > sem-site > fora-do-ar (inclui dns-morto) > ssl-invalido > http>=400 > demais problemas → `site-ruim` > `site-ok`. Wix com 3 assinaturas = 1 problema (`construtor-Wix`).

### 3.2 Quando roda — dentro do `tickProspecting`, sem fila nova

* **Fase pura (no `insert`, sem rede):** `normalizeProspect` não reescreve o `website` — o campo cru é a única fonte da URL para a fase de rede. Se o `website` for agregador (lista `DOMINIOS_IGNORADOS`: `instagram.com, facebook.com, linktr.ee, forms.gle, api.whatsapp.com, wa.me, …`) ou nulo/vazio, o insert já grava `data.site = {classe:"agregador"|"sem-site", …}` pronto. Custo zero, 40%+ dos casos resolvidos aqui (medido §1.1).
* **Fase rede (no tick, com lock por org):** após `synchronizeSearch`, enriquece candidatos com `data.site IS NULL` **independentemente de status** (`new`, `queued` e `sent` — os 50 já abordados ganham auditoria para a retomada) e `website` não-nulo, ordem `created_at`, teto que caiba no deadline de 180s (6 paralelos × ~1s médio medido ⇒ 30/rodada/org; o resto fica para o próximo tick; idempotente por construção). Âncora exata: entre o laço `for searches → synchronizeSearch` e o `select running → sendNextCandidate` (`worker.ts:392-407`), ainda dentro do `withProspectingLock(pool, org)` (`worker.ts:377`), reusando o `db: PoolClient` segurado (sem conexão nova) e checando `Date.now() >= deadline → break` como em `worker.ts:375`. Posição proposital: depois da busca materializar `queued/new` e **antes** do envio consumir quota/LLM — depois do envio seria tarde (copy sem gancho); dentro de `sendNextCandidate` seria após `recordSend` (gastaria budget anti-ban com fetch).
* Fetch com `AbortSignal.timeout(8000)`, `redirect:"follow"`, UA de navegador. Retry único só em falha transitória (timeout/conexão); DNS-morto e SSL falham na hora.
* **SSRF não é opcional: o alvo vem do banco (dado de terceiro), não de allowlist.** Guarda obrigatória no fetch, testada sem rede: só `http:`/`https:` (sem `file:`, sem userinfo na URL); resolve o host e recusa IP privado/loopback/link-local (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`) **antes** de conectar; cada redirect revalida (teto 5, mesma regra); corpo abortado ao passar de 200KB (não apenas fatiado depois); sem cookies/credenciais no request. `allowlistedFetch` (`edge/egress`) não serve aqui — ele é fail-closed para hosts fixos de provedor, o oposto deste caso.
* **Nenhum ponto novo de IA** (`lib/ai/pontos/registro.ts`): a classificação é determinística (zero chamada de modelo, zero custo) e a copy reusa a chamada existente do `gerarAbordagemDeFormulario` — o teste `pontos-de-ia-completude` só exige entrada para chamada **nova**, e aqui não há.
* **Mensagem de conclusão com o funil de descarte** (padrão do sistema de referência): ao fechar a rodada, a campanha registra não só `result_count/skipped_count`, mas o **motivo** — inválidos (`normalizeProspect` nulo: sem nome/place ou fechado), duplicados (`on conflict do nothing`), mais a distribuição das classes do enriquecimento (agregador/sem-site/ruim/ok). Telefone ausente **não** é motivo de descarte na busca (o candidato entra e `triarCandidato` decide no envio). Sem isso o operador compara com o Google ("lá tem 20, aqui veio 2") e conclui que a busca quebrou. Contagem por motivo em `metadata` do audit + visível no histórico da campanha.
* `audit()` **só** se enriqueceu ≥1 candidato na rodada (regra: cron que não fez nada não é mutação — `worker.ts:313`). Metadata sem PII: `campaign_id`, `enriquecidos`, `classes` (contagem por classe). Sem telefone, sem texto, sem URL completa (só host conta como fato operacional? não — nem host; a URL vive no `data`). Ação nova registrada na lista única `lib/audit/actions.ts` (o painel deriva o filtro dela — ação fora da lista não aparece).
* Reanálise manual: botão "Reanalisar site" no card reescreve `data.site` via action nova no `POST /api/v1/prospecting` existente (**fechada a token** — fora de `ACOES_ABERTAS_AO_TOKEN` até decisão em contrário; exige sessão com `requireRole` + `requireSupportWrite` antes do efeito, como todo handler mutante). Se o site melhorou para `site-ok`, a fila mostra honestidade > venda (o candidato continua abordável, mas sem ângulo de conserto).
* Prévia da abordagem: botão "Prévia da abordagem" chama action nova **somente-leitura** no mesmo `POST` (sessão, fora da allowlist de token; gera via `gerarAbordagemDeFormulario` sem enviar, sem mudar nada — logo **sem audit**, só custo em `llm_calls`; fora da janela de envio a tela mostra o aviso em vez de esconder, convenção do Testar do agente).

### 3.3 Vocabulário fechado de problemas (o que a tela e a IA podem dizer)

`sem-https, ssl-invalido, fora-do-ar, dns-morto, http-{status}, nao-mobile, lento, quase-vazia, construtor-{Wix,Canva,...}, sem-atualizacao-desde-{ano}, conteudo-misto, falta-{whatsapp,tel,mailto,social,mapa,fotos,titulo,description,favicon}`. Nada fora desta lista chega à tela nem ao prompt — é a cerca contra IA inventando diagnóstico.

### 3.4 Estratégia + prompt por situação (determinístico + Gateway)

* `lib/prospecting/estrategia-site.ts` (função pura): `data.site` → `{cenario, angulo, ganchos[≤3], objecoes[{objecao,resposta}][≤3], proximoPasso}`. Cenários na ordem do sistema de referência, validados contra a amostra real: `agregador/sem-site` ("Instagram ativo, invisível no Google"), `fora-do-ar` (aviso de cortesia, urgência máxima), `ssl-invalido/sem-https` (print do "não seguro"), `nao-mobile`, `lento`, `construtor-*` ("nota alta merece site à altura"), `quase-vazia`, `site-ok` (prioridade baixa, sem ângulo de conserto).
* A abordagem fria (`worker.ts:231`) ganha 3 linhas em `dados`: `Site`, `Auditoria` (classe + problemas em linguagem leiga) e `Detalhe real` (`conteudo_resumo`, 1 frase). Teto existente (`MAX_VALOR 500`) continua valendo — resumo é truncado, nunca o HTML.
* **Enriquecimento e auditoria independem de canal; envio não.** Medido na VPS: todas as campanhas iniciadas usam sessão `waha` WORKING; nenhuma usa API oficial ou BSP — e nem poderia: `validateConfig` exige `freeformOutsideWindow` (`store.ts:244`), ou seja, hoje só o waha prospecta; canais de hetero-restrição (template/janela de 24h) são recusados por decisão de produto, não por falta de código. Provedor novo (ex: um BSP como Zenvia — que **não existe** no repo, `grep` zerado) entra como 1 linha na matriz de `lib/channels/capabilities.ts` + padrão no lint, sem tocar em feature nenhuma (invariante 1 da doutrina de canal). Enriquecer site de candidato de campanha draft sem canal funciona igual.
* Saudação por horário e sorteio de fechamento acontecem **no servidor** (não no modelo), como no sistema de referência — LLM "sorteando" colapsa para o mesmo padrão.
* **Ajuste obrigatório de 1 regra no motor** (medido em `lib/agent-engine/agent/abordagem-de-formulario.ts:169`): o ramo `prospeccao_fria` hoje manda "não demonstre saber mais do que o nome do negócio e o ramo" — citar "seu site está fora do ar" viola a letra dessa regra. A emenda cirúrgica: exceção para **auditoria verificada pelo servidor** (dado que o próprio worker buscou há minutos, com `verificado_em`), distinguindo "demonstrar que sabe" (invasivo, continua proibido) de "citar observação pública verificada" (o gancho de venda). Sem essa emenda, a copy ou desobedece a regra ou não cita o site. O PR altera a regra + teste do `blocoDeModo`; nota (Avaliação) e endereço já trafegam em `dados` hoje (`worker.ts:231`) e não precisam de nada.
* **Enriquecimento nunca bloqueia fila nem envio (fail-open).** Falha no fetch/classificação = `data.site` continua ausente e o candidato tenta de novo no próximo tick; estratégia que falhar = abordagem sai sem as 3 linhas de site (padrão do `stage-classifier`: sugere, nunca decide; sem hint o turno segue). Nenhum erro aqui pausa campanha, muda `status` ou atrasa `next_send_at` — mesma disciplina do watchdog que prefere enfileirar a dropar.
* **Ofertas da campanha** (`ofertas: ("site" | "automacao_crm" | "automacao_n8n")[]`, default `["site"]`): a auditoria (`classe`, `problemas`, `checklist`) é factual e não muda — só a **leitura** muda. `montarEstrategia(site, ofertas, nicho)` escolhe o melhor ângulo por lead, na prioridade declarada da campanha: sem-site puxa ângulo `site`; volume alto de avaliações + site-ok puxa `automacao_crm` (fila de atendimento) ou `automacao_n8n` (integrações, planilhas, follow-up automático); agregador/só-rede puxa o complemento digital. O campo vive no `config` jsonb da campanha (schema Zod estendido, default atual = comportamento das campanhas existentes, sem migration). A `instruction`/`qualification` da campanha — que já personalizam o modelo — carregam o resto do posicionamento.
* **Vocabulário por nicho** (dado versionado, não código espalhado, **sem tabela nova**): mapa base em const (`clínica → "agenda de pacientes"`, `restaurante → "reservas e pedidos"`, etc.) + sobrescrita por org em `organizations.settings` (jsonb que já existe). Quando o candidato já virou lead num funil, o `vocabulary` do pipeline (`crm_pipelines`) tem precedência sobre o mapa. Nicho novo = linha no mapa ou na settings da org, nunca branch de código. O nicho vem do `search.niche` da campanha.
* **Marca e voz por organização**: marca resolve do banco (`platform_branding`, `organizations.settings.branding`, `marcaDaSaida()` fora do DOM); voz do vendedor em `organizations.settings.vendedor.*` (jsonb existente; tela em Configurações — superfície obrigatória pela doutrina, detalhe no PR). Nunca nome do produto nem do operador hardcoded. Vale para o uso fechado (venda de tenant) e para a base open source: o mesmo código, outra marca.
* Prova-em-par (`docs/doctrine/prova-em-par.md`): cada cenário tem 1 caso de aceite medido em par — copy pelo agente publicado **e** `gerarAbordagemDeFormulario` direto com o mesmo `dados` cru; o caso só conta se os dois concordarem.
* **Jev: fora do caminho crítico, por desenho (hipótese INFERIDA — sem dado de conversão ainda).** O Jev (`lib/ai/decisao/`) é juiz probabilístico em cascata: a regra determinística decide primeiro e ele só é perguntado onde ela disse não/inconclusivo; nunca bloqueia, cala ou responde sozinho (só observa, grava `jev_observacoes` e no máximo abre aviso na Central; `disjuntor` + nunca lança). Fatos técnicos (viewport ausente, `CERT_*`, `http-404`) não são juízo — regra pura resolve, de graça, para centenas de candidatos por tick. Papel reservado (spec futura, não esta): juiz de **casos inconclusivos** (ex: fronteira do "quase-vazia", construtor incerto) e **propensão de fechamento por cenário+oferta** quando houver histórico real de conversão para calibrar limiar — sempre atrás de config por org + disjuntor, com fail-open para o default determinístico. A superfície de configuração desse futuro **já existe**: a tarefa nova aparece em `/app/ai/providers` com os estados `observando/decidindo/desligada`, sem tela nova. Chamar o Jev por candidato hoje seria custo sem dado para calibrar.

### 3.5 PageSpeed — opcional, cacheado, por organização

* Chave opcional em configurações da organização (nunca env global — medido: não existe `PAGESPEED_*` na VPS), gratuita (25k/dia por projeto Google, funciona sem chave em cota leve). Padrão de UX para BYOK: valor **mascarado** (`••••1234`), link "onde obter a chave" e **validação com 1 chamada real mínima antes de salvar** (recusa chave inválida na hora, não na primeira fila). Sem chave, funciona em cota leve anônima; sem resposta, `pagespeed: null` e a tela mostra "medição indisponível".
* Medido fora do GET do lead: só no job, com `medida_em` para exibir idade. Quota/latência reais **não medidas** (sem chave) — declarado no §8.

### 3.6 Score com 4ª categoria

```
score = min(max(nota-4.0,0),1)*40 + min(avaliacoes,100)*0.3 + site
site: sem-site 30 = agregador 30 > fora-do-ar 25 = ssl-invalido 25 > site-ruim 22 > site-ok 10
```

(`agregador` pontua como `sem-site`: na prática não há site próprio — achado §1.1.) Fórmula espelhada em TS (fila) e SQL (ordenação com paginação), como o sistema de referência fazia com `calcular_score` + `SQL_SCORE`. Padrão da casa (`score-formula.ts`): **score sem motivo não é exibido** — o TS deriva `motivo` do cálculo (qual parcela dominou, ex: "nota alta + sem site") e a fila mostra os dois. Os pesos viram parâmetro por oferta primária da campanha (`ofertas[0]`; para automação, volume de avaliações pesa mais e situação do site pesa menos) — mesma função, uma tabela de pesos por oferta, cada uma travada por teste. A ordenação por score chega via parâmetro novo no `GET /api/v1/prospecting` (`ordenar=score`, enum validado, default mantém `created_at desc` — o GET atual não ordena nada além disso). Limiares viram constante nomeada com teste; tuning de peso é mudança de produto e exige nova medição.

### 3.7 Tela — auditoria inline, sem porta nova, sem endpoint novo

A auditoria **estende o `LeadEnrichment` que já existe** (`components/inbox/LeadEnrichment.tsx`, alimentado por `crm-summary` lendo `prospecting_candidates.data` com `collected_at` + aviso "dados públicos; podem ter mudado") — nova seção após os dados da empresa com placar (reputação + classe do site + pontos a corrigir), problemas em linguagem leiga, raio-X tem/falta, estratégia, botão "Reanalisar site" e botão "Prévia da abordagem" (gera a copy **sem enviar**, só leitura; fora da janela de envio mostra o aviso em vez de esconder, convenção do Testar do agente). Mesma seção no cockpit da tela de prospecção, onde os dados já viajam no `GET` (`_client.tsx:~1162`, ancorado no link "Site da empresa"; Badge de score em `~1183`; 5º KPI no header `~508`; ordenação via §3.6). Regra herdada: **contato anonimizado não vê enriquecimento** (`crm-summary:100`, `CRMSidePanel:727`) — a auditoria some junto, sem exceção. **Sem PDF** (decisão do dono em 10/10/2026). Sem item novo no sidebar (limite de espaço documentado em `catalogo.ts:128`).

---

## 4. Fora do escopo (escrito para não voltar como "e se")

1. **Instagram via automação de conta** (`instagrapi`, sessão pessoal, leitor DOM de WhatsApp Web do app desktop de referência): recusado — ToS Meta, risco de ban, sem RLS/multi-tenant, fora do canal WAHA (`lib/channels/` + `waha-adapter.ts`, `messaging-window.ts`, opt-out em `lib/opt-out/deteccao.ts`). Canal social futuro só via API oficial Meta, em spec própria.
2. **PDF de diagnóstico**: cortado pelo dono; a auditoria inline é o entregável.
3. **Qualquer runtime além de Node 22**: sem Python, sem binário, sem sidecar, sem container novo (packaging: `docker-compose.prod.yml` só `image:` publicada).
4. **Mudança no ritmo da esteira fria** (`ritmo-da-esteira-fria.ts`), janela de mensagem, opt-out ou cadeia before-send: o enriquecimento é leitura pública + escrita em `data`; não toca envio.
5. **Reescrever `normalizeProspect`**: proibido reescrever o `website` no insert — o campo cru é a URL que a fase de rede vai buscar. O veredito puro (agregador/sem-site) é registrado em `data.site` no próprio insert; o resto do contrato de `normalizeProspect` não muda (detalhes no PR).

---

## 5. Living System Checklist (respostas com artefato, não promessa)

```
Living System Checklist — enriquecimento de site
[1] Quem me alimenta?      cron/prospecting (route) → tickProspecting → candidatos com data.site IS NULL
[2] Quem eu alimento?      card do candidato (auditoria inline), score da fila, dados da abordagem fria
[3] Que registro eu emito? audit(prospecting.site_enriched) quando enriqueceu ≥1; instrumentation do tick
[4] Onde apareço na tela?  card do candidato em /app/prospecting (auditoria + estratégia + reanalisar)
[5] Por qual porta se chega? porta existente /app/prospecting (catalogo.ts:140); sem porta nova
[6] Anti-morte?            data.site IS NULL = fila de pendentes visível (qualquer status, inclusive sent para retomada); reanálise manual; follow-up/cadência existentes cobrem o lead
[7] Onde se configura?     ofertas[] no config da campanha (tela de início, default ["site"]); dicionário de nicho global+org; chave PageSpeed opcional por org em Configurações; sem chave = "medição indisponível" (falha visível, não silenciosa)
[8] Continuidade IA↔humano? estratégia + copy assistida; humano revisa e envia (token não inicia campanha — route.ts:122); buildHandoffSummary cobre a resposta
[9] Laço de retorno?       classes erradas corrigidas via "Reanalisar" + contagem de classes no audit; peso do score reajustado por medição, não por opinião
[10] Atualizei o mapa?     docs/architecture/*.json com aresta busca→enriquecimento→fila/abordagem (sem re-render: archify 2.11.0 recusa o formato — ver docs/architecture/README.md)
```

---

## 6. Plano de testes (o que o PR precisa ter verde)

* **Unit (vitest, `lib/prospecting/`)**: classe derivada × matriz de fixtures (agregador, dns, ssl, http-404, sem-https, nao-mobile, lento, construtor ×3 assinaturas→1 rótulo, quase-vazia, ok); filtro de agregador sobre a amostra real anonimizada (só hosts); estratégia por cenário × oferta × nicho (inclui default `["site"]` = comportamento atual e fallback de nicho fora do dicionário); score com 4ª categoria e pesos por oferta primária; SQL↔TS do score concordando; parâmetro `ordenar=score` (enum inválido = 422, default preservado); emenda do `blocoDeModo` (auditoria verificada citável, resto da regra intacto) + truncamento em `MAX_VALOR`.
* **Sabotagem**: reverter 1 linha da regra (ex: agregador antes do fetch) e prever quais casos caem — "N vermelhos de M, os previstos" no corpo do PR.
* **Invariantes (`pnpm test:db`)**: enriquecimento de outra org não aparece (isolamento); `unique (organization_id, place_id)` intacto; sem grant novo (o update usa pool do worker/service-role existente).
* **E2E (Playwright, 6 partes no CI)**: spec nova da auditoria inline em banco fresco do `baseline.sql` (candidato com `data.site` fixo → painel, estratégia, reanálise, prévia sem envio); registra em `SPECS_PARTE_N` ou `FORA_DO_CI` com motivo + `e2e-cobertura-completa.test.ts` verde.
* **Par IA** (§3.4): 1 caso por cenário em par agente-direto, com o mesmo `dados` cru.

---

## 7. Riscos e portas de saída

| Risco | Mitigação |
|---|---|
| Fetch em site hostil/lento trava o tick (deadline 180s) | timeout 8s + teto 30/org/rodada + resto no próximo tick; sem fetch em agregador/sem-site (40%+ poupados) |
| Classificação errada queima abordagem | `site-ok` nunca gera ângulo de conserto; reanálise manual; vocabulário fechado impede IA de inventar |
| IP da VPS bloqueado por N sites | 6 paralelos, 1 retry só em transitória, sem re-fetch de enriquecido; throttle configurável se medição futura mandar |
| PageSpeed sem chave/cota | best-effort + `null` visível; chave por org quando houver |
| Peso do score vira achismo | pesos desta spec + teste travando; retuning só com nova medição |

---

## 8. O que NÃO foi medido (separa medição de relato)

* Latência/quota reais do PageSpeed (sem chave na VPS); timeout de 60s do sistema de referência não adotado sem medir.
* Amostra com DNS-morto e com `lento >5s` (nenhum nos 20); regra existe, casos de borda entram no PR com fixtures sintéticas.
* Pressão de memória com páginas reais de 200KB × 6 paralelos (spike local usou `example.com`; teto do worker cobre, mas o PR mede com 20 reais e `docker stats`).
* Prova em tela e sabotagem: fase de implementação, não desta spec.
* Instagram oficial, SDK, marketplace, extração de recurso do núcleo: não existem e não são prometidos.
* Fonte alternativa de busca (Places API oficial): fora desta spec, mas sem tabela nova quando vier — `map_provider_credentials` (org, provider, chave cifrada, last4) **já existe** e está zerada na VPS; o despacho por org (`provedorDaOrganizacao`) também já existe. É o encaixe natural da próxima spec.

---

## 9. Critério de pronto (Definition of Done aplicável)

typecheck/lint/`lint:channels`/`lint:role-rank` zerados; unit + invariants + e2e da mudança verdes; `audit()` onde houve mutação; Zod em inputs externos (action de reanálise, `ofertas[]`, chave PageSpeed); nenhuma tabela/coluna/grant novos (ou tripla completa se surgirem); prova visual da auditoria inline; Living System Checklist acima respondido; mapa em `docs/architecture/` atualizado; fragmento `.changes/` (`capacidade_nova`) no PR — nunca seção à mão no `CHANGELOG.md`.
