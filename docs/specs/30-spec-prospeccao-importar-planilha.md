---
title: "Spec Técnica 30 — Prospecção a partir de planilha (CSV ou XLSX)"
parent: 00-prd-master.md
type: spec
scope: prospecção
status: draft
version: 0.1.0
owner: arquitetura
created_at: 2026-10-27
related:
  - 24-spec-enriquecimento-site-prospeccao.md
  - ../features/prospeccao-nativa.md
---

# Spec 30 — Prospecção a partir de planilha

> Hoje a única porta de entrada da prospecção é a **busca paga no Google Maps** (Apify ou
> provedor configurado). Quem já tem a própria lista de empresas — de feira, de associação,
> de uma planilha antiga — não consegue usá-la: precisa pagar uma busca e torcer para as
> mesmas empresas aparecerem. Esta spec acrescenta uma **segunda porta**: o administrador
> sobe um `.csv` ou `.xlsx`, a planilha vira uma campanha em rascunho com os candidatos já
> carregados, e daí em diante **tudo é o caminho que já existe** (seleção, auditoria de
> site, prévia, agente, ritmo, fila, Inbox, LGPD). Nenhuma tabela nova, nenhuma migration,
> nenhuma dependência nova.

---

## 1. Medições que sustentam a spec

Todas refeitas em **2026-10-27, 20h59–21h03**, contra `origin/main` = `f13d26f6b` e contra o
banco da instalação oficial (consultas agrupadas por `organization_id`, só contagem).

### 1.1 Uso real da prospecção (oficial)

| organização | campanhas | período | enviados | na fila | novos | pulados |
|---|---|---|---|---|---|---|
| `043c9d27…` | 12 (1 ativa) | 03/10 → 27/10 | 72 | 34 | 27 | 35 |
| `59914589…` | 11 | 21/09 → 27/10 | 235 | 35 | 40 | 42 |

Motivos dos pulados: "Não selecionada pelo operador." (31 + 31) e "Sem telefone brasileiro
válido." (4 + 11). Nenhum pulado por "Contato já existe" nessas listas do Maps — numa lista
própria esse motivo deve ser bem mais comum (ver §6, pergunta 1).

### 1.2 Onde o candidato nasce hoje — um único ponto

`lib/prospecting/store.ts`, `synchronizeSearch` (linhas ~209–300): para cada item do provedor,
`normalizeProspect(item)` → `vereditoPuro(p.website)` (spec 24, fase sem rede) →

```sql
insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data)
values($1,$2,$3,$4,$5) on conflict do nothing
```

→ fecha com `search_status='succeeded'`, `result_count`, `skipped_count` e **um**
`audit("prospecting.search_completed", {total, inseridos, duplicados, invalidos, classes_puras})`.

### 1.3 O que o banco já garante (baseline, apêndice da 0369/0370/0506)

- `unique (organization_id, place_id)` e `unique index prospecting_phone_once_org (organization_id, phone) where phone is not null` → a mesma empresa/telefone **não entra duas vezes na organização**, venha de qual busca vier.
- Gatilho `prospecting_refuse_erased` → recusa em silêncio (`return null`) quem foi anonimizado, comparando HMAC do `place_id` **ou** do telefone.
- A anonimização reescreve `place_id = 'redacted:'||id` e guarda o HMAC do `place_id` original.
- `prospecting_campaigns.search` é `jsonb` sem CHECK; `unique (organization_id, request_id)` dá idempotência de criação.
- RLS ligada, tabelas só para `service_role` (rotas resolvem o tenant e filtram à mão).

### 1.4 O que o resto da esteira lê de `search` e de `data`

| leitor | lê | consequência para a planilha |
|---|---|---|
| `opcoesDoPreparo(c.search)` (`lib/prospecting/opcoes-do-preparo.ts`) | `avaliar_site`, `gerar_previa` | gravar as duas chaves na campanha importada |
| `previa-gerar.ts:91` | `search.niche ?? data.category` | pedir "público ou segmento" na importação |
| `agent-chat.ts:206` | `campaign.search` inteiro, como contexto do assistente de configuração | `origem: "planilha"` chega ao assistente sem mudança |
| `agent-chat.ts:162`, `agent-session.ts:114`, `activateCampaign` (`store.ts:670`) | exigem `search_status='succeeded'` | campanha importada nasce `succeeded` |
| worker (`worker.ts:679,709`) | só olha `search_status in ('starting','running')` | campanha importada nunca é sincronizada (sem `run_id`) |
| `triarCandidato`, `criarPegadaDoCandidato` | `phone`, `data.name`, `data.key`, `data.maps_url` | `key` sintético, `maps_url` nulo — já é aceito |
| `normalizeProspectPhone` (`schema.ts`, **privada**) | regra de telefone da prospecção (#3080) | exportar e reusar; não usar `normalizaTelefone` dos contatos (régua diferente → a triagem recusaria depois) |

### 1.5 Leitor de planilha que já existe

`lib/crm-b2b/spreadsheet.ts` → `parseImportFile(bytes, filename)`: CSV pelo `parseCsv`/`decodificarCsv`
de `lib/contacts/csv.ts` (RFC 4180, `;` do Excel, Latin-1) **e** XLSX pelo `fflate` (já em
`package.json`, `^0.8.3`), com teto de XML descompactado contra zip-bomba. Não há `xlsx`/SheetJS
no projeto de propósito (CVE-2023-30533 e CVE-2024-22363, ver cabeçalho de `lib/leads/planilha.ts`).

Problema: o arquivo mora no **módulo B2B**, que pode estar desligado (`seModuloB2bDesligado`).
A prospecção é núcleo; o núcleo não deve importar de dentro de um módulo.

### 1.6 Busca de trabalho paralelo

`gh search` no `melgarafael/DeskcommCRM` por "prospecção planilha", "prospecção csv",
"importar prospecção", "lista própria prospecção", "prospecting import", "prospecção xlsx"
(issues e PRs): **nenhum resultado** em 27/10, 21h.

---

## 2. Escopo

**Dentro:** criar campanha de prospecção a partir de `.csv` ou `.xlsx` (primeira aba), com
mapeamento automático de colunas, relatório de linhas recusadas e o resto da esteira inalterado.

**Fora (de propósito):**
- Acrescentar linhas a uma campanha já existente (cada planilha = uma campanha; evita mexer em fila iniciada).
- `.xls` binário antigo, várias abas, fórmulas (vale o último valor gravado pelo Excel — comportamento do leitor atual).
- Abordar quem **já é contato** do CRM (regra atual da triagem preservada — ver §6, pergunta 1).
- Token/bearer (`dsk_…`): a rota é só de sessão, como `reanalisar_site`.

---

## 3. Desenho

### 3.1 Leitor neutro (refator sem mudança de comportamento)

- Mover `parseImportFile`, `isCsvFilename`, `isXlsxFilename`, `IMPORT_MAX_BYTES` e o leitor XLSX de `lib/crm-b2b/spreadsheet.ts` para **`lib/planilha/ler-arquivo.ts`**.
- `lib/crm-b2b/spreadsheet.ts` passa a **reexportar** (mantém `suggestColumnMapping`/`applyMapping`, que são do domínio B2B). `lib/crm-b2b/spreadsheet.test.ts` continua verde sem edição.
- O teto de linhas vira parâmetro (`maxLinhas`, default 2.000 = comportamento atual).

### 3.2 Domínio: `lib/prospecting/planilha.ts`

```ts
export const PLANILHA_MAX_LINHAS = 500;          // 10 dias no teto de 50/dia
export function lerPlanilhaDeProspeccao(sheet: SheetMatrix):
  { candidatos: Prospect[]; erros: { linha: number; motivo: string }[]; colunasIgnoradas: string[] }
```

Colunas reconhecidas (comparação sem acento e sem caixa, mesmo padrão de `lib/leads/planilha.ts`;
inclui formas em espanhol):

| campo `Prospect` | apelidos | obrigatório |
|---|---|---|
| `name` | empresa, nome, nome fantasia, razão social, negócio, nombre, empresa | sim |
| `phone` | telefone, celular, whatsapp, fone, phone, teléfono, móvil | sim |
| `website` | site, website, url, página, sitio web | não |
| `category` | segmento, categoria, ramo, nicho, rubro | não |
| `address` | endereço, cidade, local, dirección | não |
| `emails` | email, e-mail, correo | não (até 5, separados por `,`/`;`) |
| `socials` | instagram, facebook, linkedin, redes | não (só `http(s)` via `safePublicLink`) |

Regras por linha (recusar é a função — nunca chute):
- sem nome (< 2 caracteres, mesma régua do `createLeadSchema`) → recusada "Sem nome da empresa.";
- telefone que `normalizeProspectPhone` (agora exportada) não aceita → recusada "Sem telefone válido.";
- mesmo telefone repetido **dentro do arquivo** → a primeira fica, as outras recusadas "Telefone repetido na planilha (linha N).";
- `key` = `planilha:` + telefone E.164 (estável: reimportar o mesmo número bate no `unique` e no gatilho de supressão de LGPD);
- `maps_url`, `rating`, `reviews` = `null`; textos cortados nos mesmos limites de `normalizeProspect`;
- linha que excede `PLANILHA_MAX_LINHAS` → arquivo inteiro recusado com a mensagem (não importar "os primeiros 500" em silêncio).

Arquivo sem coluna de nome **ou** sem coluna de telefone → erro do arquivo, listando as colunas
encontradas e os nomes aceitos.

### 3.3 Persistência: `importarPlanilha` em `lib/prospecting/store.ts`

Dentro de `withProspectingLock(pool, org, …)`, numa transação:

1. `select` por `(organization_id, request_id)` → se existe, devolve a mesma campanha (idempotência; repetir o envio não cria outra).
2. `insert into prospecting_campaigns(organization_id, request_id, name, search, search_status, result_count, skipped_count)` com `search_status='succeeded'`, `run_id` nulo, e
   ```json
   { "origem": "planilha", "name": "...", "niche": "...", "arquivo": "lista.xlsx",
     "linhas": 312, "origem_da_lista": "texto do operador",
     "avaliar_site": true, "gerar_previa": true }
   ```
3. Para cada candidato, o **mesmo** `insert … on conflict do nothing` de `synchronizeSearch`, com o mesmo `vereditoPuro(website)` (spec 24).
4. `result_count` = inseridos; `skipped_count` = duplicados na organização + recusados pelo gatilho de LGPD (o `on conflict` e o `return null` do gatilho são indistinguíveis por `rowCount`; o relatório diz "já estavam na base ou foram excluídos a pedido do titular", sem separar — não inventar sinal que o banco não dá).

Extrair o laço de inserção de `synchronizeSearch` para uma função comum (`gravarCandidatos(db, org, campaignId, prospects)`) usada pelos dois caminhos, para não nascer a segunda verdade sobre "como um candidato entra".

`Campaign.search` passa a ser `SearchInput | BuscaDaPlanilha` (tipo união). `searchSchema`
(entrada da ação `search`) **não muda**.

### 3.4 Rota: `POST /api/v1/prospecting/importar` (multipart)

Arquivo novo `app/api/v1/prospecting/importar/route.ts` (multipart não cabe na união JSON de
`prospectingInputSchema`):

- `requireSupportWrite()` antes de qualquer efeito.
- Auth de **sessão**, papel `admin` (o mesmo de `POST /api/v1/prospecting`). Sem entrada em `lib/auth/public-paths.ts` (bearer fica de fora de propósito).
- `organization_id` do contexto autenticado, nunca do formulário.
- Campos: `file`, `request_id` (uuid), `name` (2–120), `niche` (2–120), `origem_da_lista` (3–500), `avaliar_site`, `gerar_previa` — validados por Zod (`importarPlanilhaSchema` em `lib/prospecting/schema.ts`).
- Tamanho: `IMPORT_MAX_BYTES` (2 MB) antes de ler o corpo inteiro.
- Erros no formato `fail()`: `validation_failed` 422 (arquivo/colunas/linhas), `conflict` 409 nunca é preciso (idempotente).
- Sucesso `ok()` com `{ campaign, inseridos, ja_na_base, recusadas: [{linha, motivo}] (até 100), colunas_ignoradas }`.
- `audit({ action: "prospecting.changed", metadata: { operation: "importar_planilha", arquivo_bytes, linhas, inseridos, ja_na_base, recusadas, classes_puras } })` — **sem** nome de arquivo nem dado de linha (nome de arquivo pode conter nome de pessoa).
- Emite `prospecting.changed` como as outras ações (a tela já reage a ele).

### 3.5 Tela: `/app/prospecting`

No cartão **"1. Encontrar empresas"**, duas abas: **Buscar no Google Maps** (o formulário atual,
intacto) e **Usar minha planilha**:

- Campos: arquivo (`.csv,.xlsx`), nome da campanha, público ou segmento, **"De onde veio esta lista?"** (obrigatório), as duas caixas de auditoria de site/prévia (mesmo texto e mesmo default das atuais).
- Texto fixo abaixo: "Aceita .csv ou .xlsx (primeira aba), até 500 empresas. Colunas obrigatórias: nome da empresa e telefone. Quem já é contato do CRM não é abordado. Nenhuma abordagem começa nesta etapa."
- Link "Baixar modelo" → CSV gerado no navegador com o cabeçalho `empresa;telefone;site;segmento;cidade;email;instagram` e uma linha de exemplo fictícia.
- **Não depende da chave do provedor**: a aba de planilha fica habilitada com `configured=false` (hoje o botão de busca usa `disabled={!data?.configured}`).
- Depois de enviar: resumo na própria tela ("312 linhas · 280 entraram · 20 já estavam na base · 12 recusadas") e a lista das recusadas com linha e motivo. A campanha aparece em "Suas campanhas" com o rótulo **"Planilha"** no lugar do estado da busca.
- Strings novas no `lib/i18n/dicionario.ts` (es) e `lib/i18n/traducoes/*.json`, como as atuais.

### 3.6 Contexto do agente

`lib/prospecting/context.ts` diz "Uma empresa encontrada na pesquisa ainda não é um cliente
qualificado." Trocar para "Uma empresa da lista da campanha ainda não é um cliente qualificado."
(vale para os dois caminhos; nenhuma outra mudança no prompt).

---

## 4. LGPD

- A base legal continua a mesma da campanha (`legal_basis_ref`, obrigatória no `start`) e vai para `contacts.consent.legitimate_interest` pelo caminho atual.
- **"De onde veio esta lista?"** é obrigatório na importação, fica em `search.origem_da_lista`. O export do titular já entrega `campaign_id` e `place_id` (`planilha:…` diz que veio de lista própria); devolver também o texto de `origem_da_lista` no export fica para um PR seguinte (toca a projeção da LGPD e as cercas dela).
- Supressão: quem foi anonimizado não volta por planilha (HMAC do telefone no gatilho existente — coberto pelo invariante `tests/invariants/lgpd-alcanca-prospeccao-de-quem-ja-era-contato.test.ts`; acrescentar um caso com `place_id` `planilha:`).
- Opt-out "PARAR", janela de disparo, dias da prospecção, 50/24 h, intervalo mínimo de 5 min: **inalterados** — a fila não sabe de onde o candidato veio.

---

## 5. Testes (o veredito é o CI do fork)

| teste | prova | sabotagem que precisa deixá-lo vermelho |
|---|---|---|
| `lib/planilha/ler-arquivo.test.ts` (+ `crm-b2b/spreadsheet.test.ts` inalterado) | o refator não muda CSV/XLSX/zip-bomba | trocar o teto de XML |
| `lib/prospecting/planilha.test.ts` | apelidos pt/es, telefone 10/11 dígitos/+351, repetido no arquivo, sem nome, > 500 linhas, colunas ausentes | aceitar telefone `null`; não recusar o repetido |
| `lib/prospecting/schema.test.ts` (ou o existente `telefone-estrangeiro.test.ts`) | `normalizeProspectPhone` exportada com a mesma régua | — |
| `app/api/v1/prospecting/importar/route.test.ts` | 401 sem sessão; 403 para `manager`; bearer recusado; `requireSupportWrite`; 422 de arquivo; mesmo `request_id` devolve a mesma campanha; `audit` chamado uma vez sem nome de arquivo | tirar o filtro de `organization_id` |
| invariante de isolamento (2 tenants) | planilha da org A não cria candidato na B; telefone que já é candidato na B **entra** na A | — |
| invariante LGPD (caso novo) | telefone anonimizado é recusado na importação | remover o gatilho |
| `tests/unit/navegacao-completude.test.ts` | sem porta nova (a tela é a mesma) | — |
| E2E (Playwright, banco fresco do `baseline.sql`, **sem** chave Apify) | admin sobe CSV de 5 linhas (1 sem telefone, 1 repetida) → vê 3 entraram + 2 recusadas → inicia campanha com agente → fila mostra 3 | — |

Evidência no relatório do Playwright do CI e linha em `docs/testing/user-journey-map.md`.

---

## 6. Decisões (fechadas em 2026-10-27)

- **Pergunta 1 → (A):** quem já é contato do CRM é pulado, como hoje. `triarCandidato` não muda.
- **Pergunta 2 → (A):** `PLANILHA_MAX_LINHAS = 500`.

O registro das alternativas fica abaixo.

**1. Quem já é contato do CRM entra na campanha?**
- Situação: a triagem atual pula todo telefone que já é contato ("Contato já existe no CRM; atendimento preservado."). Numa planilha própria, boa parte pode ser cliente antigo.
- (A) Manter a regra: a planilha serve para **empresas novas**; cliente antigo continua no disparo em massa/follow-up. Zero mudança na fila; nenhum cliente em atendimento recebe abordagem fria.
- (B) Permitir: exige mudar `triarCandidato`, que hoje protege atendimento em curso — risco de abordar alguém no meio de uma negociação.
- **Recomendação: (A).** A tela avisa antes ("Quem já é contato do CRM não é abordado") e o resumo mostra quantos foram pulados por isso depois de iniciar.

**2. Limite de 500 linhas por arquivo.**
- (A) 500: dez dias de fila no teto atual de 50/dia; a tela de candidatos já lista até 5.000.
- (B) 2.000 (teto do leitor B2B): campanha de 40 dias, fila longa demais para revisar.
- **Recomendação: (A).**

---

## 7. Sistema vivo — checklist

1. **Quem me alimenta?** O administrador, pelo cartão "Usar minha planilha" em `/app/prospecting` → `POST /api/v1/prospecting/importar`.
2. **Quem eu alimento?** `prospecting_candidates` → a mesma esteira de `activateCampaign`/`criarPegadaDoCandidato` (contato, negócio, conversa) e `preparo.ts` (auditoria de site, prévia).
3. **Registro:** `api_audit_log` `prospecting.changed` com `operation: "importar_planilha"` (só contagens); contatos e negócios seguem com `contact.created`/`lead.created` canônicos.
4. **Tela:** resumo e recusadas no próprio cartão; campanha com rótulo "Planilha" em "Suas campanhas" (`app/app/prospecting/_client.tsx`).
5. **Porta:** a existente, CRM → Prospecção (já no catálogo de navegação).
6. **Anti-morte:** a mesma da campanha — a fila só anda com "Iniciar"; erro de envio pausa e aparece na campanha. Campanha importada e nunca iniciada fica em rascunho visível na lista (mesmo comportamento de uma busca não iniciada).
7. **Configuração:** colunas e limites declarados na tela + modelo para baixar; o que falta aparece como linha recusada com motivo.
8. **Continuidade IA↔humano:** inalterada (Inbox, handoff canônico).
9. **Laço de retorno:** as recusadas voltam ao operador com linha e motivo; ele corrige a planilha e sobe de novo (as já importadas batem no `unique` e não duplicam).
10. **Mapa:** em `docs/architecture/prospeccao-nativa.architecture.json`, nó `operator` ganha a aresta "planilha" para `candidates`, paralela à `discovery`.

---

## 8. Entrega

- **Destino:** núcleo (a prospecção é núcleo; o leitor sai do módulo B2B para `lib/planilha/`).
- **Schema:** nenhum. Sem migration, sem apêndice no baseline (afirmação a conferir no PR: `git diff --stat origin/main -- supabase/` vazio).
- **Env:** nenhuma.
- **Dependência:** nenhuma (`fflate` já está no projeto).
- **Docs:** seção "Lista própria (planilha)" em `docs/features/prospeccao-nativa.md`; mapa do §7.10.
- **Release:** fragmento `.changes/prospeccao-por-planilha.md` com `capacidade_nova`.
- **Fatias de PR sugeridas:**
  1. Refator do leitor para `lib/planilha/` + `normalizeProspectPhone` exportada (sem comportamento novo).
  2. `lib/prospecting/planilha.ts` + `gravarCandidatos` comum + rota + testes + invariantes.
  3. Tela, i18n, modelo para baixar, doc, mapa, E2E e evidência.

## 9. Não medido

- Tempo de leitura de um `.xlsx` de 500 linhas no servidor (o leitor B2B aceita 2.000; não há número gravado).
- Quantos telefones de uma lista própria típica já são contatos — depende da lista; só se mede com a primeira importação real.
