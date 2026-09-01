# Alertas de segurança triados — registro de decisão

> Onde mora a razão de cada alerta **descartado** no painel do GitHub, e o que a varredura
> por CLASSE achou que o scanner não vê. Alerta consertado não entra aqui: ele vive no
> commit que o consertou.
>
> Um `dismiss` no painel aceita 280 caracteres de comentário. A razão de verdade não cabe
> lá, e razão que não cabe vira "alguém decidiu isso em algum momento". Este arquivo é o
> destino do ponteiro que o comentário do dismiss carrega.

Complementa [`threat-model.md`](threat-model.md) (superfície de ataque do self-host) e
[`harness-audit.md`](harness-audit.md) (onde a verificação tem buraco).

---

## Rodada de 2026-08-12 — 13 alertas (6 Dependabot + 7 CodeQL)

Estado inicial medido: 6 alertas abertos do Dependabot e 7 do CodeQL. Doze foram
consertados; **um** foi descartado, e é o assunto principal deste arquivo. A varredura por
classe achou **quatro** coisas que não estavam em alerta nenhum.

### Consertados

| Alertas | O quê | Commit |
|---|---|---|
| #73, #76, #77, #78, #79, #80 (Dependabot) | 5 transitivas com advisory elevadas por `pnpm.overrides` | `fix(deps): eleva 5 transitivas com advisory` |
| #6, #7 (CodeQL `js/polynomial-redos`) | `parseChatId` deixa de fazer backtracking quadrático sobre `payload.from` | `fix(waha): parseChatId deixa de ser ReDoS polinomial` |
| #1, #2, #4, #9 (CodeQL `actions/missing-workflow-permissions`) | `permissions: contents: read` nos 3 workflows + gate no `verify` | `fix(ci): jobs declaram o privilegio do GITHUB_TOKEN` |

### Descartado — #5, `js/clear-text-logging` em `scripts/bootstrap-owner.ts:215`

**Razão registrada: `won't fix`.** Não `false positive` — metade do alerta é verdadeira, e
gravar "falso positivo" seria escrever uma afirmação falsa no registro auditável, que
envenena a régua na próxima vez que esta regra disparar de verdade.

**O alerta tem DOIS fluxos para o mesmo sink, não um.** A tela do GitHub mostra um rótulo
de origem ("process environment") e isso engana. O SARIF da análise em `f9abedd0`
(`gh api -H "Accept: application/sarif+json" .../code-scanning/analyses/<id>`) traz
`codeFlows: 2`:

- **Fluxo A — `env.NEXT_PUBLIC_APP_URL`** (coluna 101). **Falso positivo puro:** o prefixo
  `NEXT_PUBLIC_` significa, por contrato do Next.js, que o valor vai para o browser. Ele é
  público por construção.
- **Fluxo B — `OWNER_EMAIL`** (coluna 51). PII real indo para um sink de log. Verdadeiro no
  sentido estrito do CWE-532.

A fonte de taint não é o nome da variável: é o `{ ...process.env }` da linha 24. O CodeQL
marca o objeto de ambiente inteiro como sensível e o spread propaga para tudo que se lê de
`env`. É por isso que a linha 158 — que imprime `process.env.AI_PROVIDER` lido direto — não
é flagrada, e esta é: leitura direta é classificada pelo nome da chave; leitura da cópia
herda a classificação do objeto todo.

**Por que não vale patch:**

1. **O conserto não removeria um byte de exposição do produto.** O `install.sh` — o caminho
   que todo self-hoster roda — imprime o mesmo `${OWNER_EMAIL}` três vezes (linhas 1415,
   1552, 1562), e escolheu deliberadamente não imprimir a senha (`senha:  (a que você
   definiu)`, linha 1553). O CodeQL não analisa shell: o `default-setup` cobre
   `actions`/`javascript-typescript`, e não há analisador de bash. **O scanner flagrou a
   cópia que ninguém executa e é cego para a original que todo mundo executa** —
   `grep bootstrap-owner self-host-kit/` devolve zero ocorrências; o kit reimplementa
   o bootstrap inline com `curl` + `psql`.
2. **A linha tem valor de diagnóstico real.** O script é create-**or-update**: ele
   sobrescreve a senha de um usuário existente. O eco do e-mail é o único sinal de que se
   acertou a conta — e mostra o valor DEPOIS do parse, que é o que pega o `.env` com aspas
   (defeito que este projeto já teve).
3. **Fechar o alerta exigiria matar os dois fluxos.** Remover só o e-mail (a saída
   "óbvia") tira a PII e **deixa o alerta aberto**, porque o fluxo A entra pela URL que essa
   variante preserva. Trocar o e-mail pelo valor devolvido pelo Supabase mata o fluxo B e
   deixa o A. Fechar de verdade custa mais mudança do que o achado justifica — e a variante
   com fallback `?? OWNER_EMAIL` reintroduz o taint em silêncio, com typecheck verde.

**O que foi medido antes de decidir**, para o próximo leitor não ter de re-derivar:

- Os 12 `console.*` do arquivo foram enumerados um a um. `OWNER_PASSWORD` e
  `SUPABASE_SERVICE_ROLE_KEY` não alcançam nenhum deles.
- O `catch` final (`console.error("❌ Bootstrap falhou:", err)`) foi testado com um canário
  na service role key contra `@supabase/supabase-js` 2.112.1, em 5 cenários de erro (401 do
  auth, 401 do postgrest, host inexistente, conexão derrubada, `fetch` cru com o header
  `Authorization`). **O canário não apareceu em nenhum.** O pior que ele imprime é o
  hostname do Supabase, que já é público.

**Achado lateral, não consertado** (é robustez, não segurança, e está fora do escopo desta
rodada): `scripts/bootstrap-owner.ts:67` descarta o `error` de `admin.auth.admin.listUsers`.
Sob falha de rede, `data` volta `{users: []}` e o script segue — a idempotência prometida no
cabeçalho não vale quando o `listUsers` falha por rede, e ele cria um segundo dono.

---

## O que a varredura por CLASSE achou e o scanner não tinha

Triar a instância que o scanner aponta deixa as irmãs com álibi. As quatro abaixo saíram de
varrer a classe de cada alerta com um instrumento independente.

### 1. Dois advisories que o Dependabot auto-descartou — consertados

`brace-expansion@1.1.16` carregava `GHSA-mh99-v99m-4gvg` e `GHSA-rgw5-rvv9-x895` (dois
HIGH). O Dependabot auto-descartou os alertas #72/#75 e marcou #74 como *fixed* — porque a
**outra** árvore (`5.0.9`, via `@sentry/nextjs`) foi mesmo corrigida. A árvore `1.x`
continuava vulnerável e sem dono.

**A lição de método:** a lista de alertas do GitHub é uma superfície **já filtrada por
política de auto-dismiss**. Tratá-la como a superfície completa é medir contra a régua
errada.

### 2. Um HIGH que nem o `pnpm audit` enxerga — consertado

`path-to-regexp@6.1.0` (`GHSA-9wv6-86v2-598j`, CVSS 7.5) estava no lock e o `pnpm audit`
dizia "No known vulnerabilities found".

**Causa medida:** `pnpm audit` (9.15.9) **colapsa pacotes de mesmo nome e audita só o
último na ordem do lockfile**. A árvore `8.4.2`, corrigida, mascarava a `6.1.0`. Provado
com experimento controlado: num repro mínimo, variando só o nome da chave do alias (o que
muda a ordem alfabética), o alerta aparece ou some — 3 de 3 estável nos dois sentidos.

**Consequência para quem for construir um gate:** `pnpm audit` cobre as instâncias que ele
enxerga, **não a classe**. O ponto cego dele é exatamente a forma multi-árvore, que é a
forma dos dois achados acima. A medição que sustenta esta rodada é OSV.dev sobre o lock
inteiro, por `name@version`:

```
lock em f9abedd0 (controle positivo) : 5 pacotes / 9 advisories
lock depois dos overrides            : 0
```

### 3. Uma credencial viva em log — consertada

`scripts/observar-escalacao-turno-real.ts:227` imprimia `webhook_path_token` em claro.
É a credencial que autentica o webhook do WAHA e resolve o tenant. Estritamente pior que a
PII do alerta #5, e **invisível ao scanner**: entra como propriedade de objeto dentro de
`JSON.stringify`, não como identificador interpolado em template.

### 4. Seis ReDoS polinomiais que o CodeQL não flagrou — NÃO consertados

Varredura dinâmica de 8.404 literais de regex em 1.909 arquivos (controle positivo: o
detector flagra `lib/waha/ingest.ts`), filtrada por crescimento quadrático confirmado em 3
pontos **e** entrada externa verificada lendo o call site:

| Local | Custo em 64 KB | Entrada |
|---|---|---|
| `lib/ai/anonymize/index.ts:26,59` | ~3,3 s | **A pior.** `anonymize(transcript)` roda sobre a concatenação dos `messages.body` da conversa — corpo de mensagem de WhatsApp, sem teto de tamanho antes |
| `lib/sentry/scrub.ts:56` | ~3,2 s | Indireta (dado de evento Sentry) |
| `lib/agent-engine/guardrails/vazamento-interno.ts:398` | ~4,5 s | Parcial — por token da saída do LLM; teto real de `max_tokens` **não medido** |
| `lib/ai/skills/package.ts:84,85` | ~2,9 s | Autenticada (`requireRole("manager")`), mas o SKILL.md vem descompactado de zip — zip-bomb de espaços dá N grande com upload pequeno |
| `lib/mcp/auth.ts:72` + `app/api/internal/agents/run/route.ts:53` | ~160 ms | **Não autenticada** — é o próprio check de auth, e `/api/mcp` é rota pública. Limitada pelo teto de 16 KB de header do Node, mas ~6 req/s saturam um core |
| `app/api/v1/channels/partner/route.ts:78` | ~166 ms | Header `origin`, controlado pelo cliente; atrás de `adminGate` |

**Por que ficaram de fora desta rodada, e não é por serem menores:** quatro das seis são
regex de **detecção de PII** ou de **autenticação**. Perder um match ali não degrada
performance — vaza dado pessoal ou aceita credencial malformada. A equivalência precisa ser
provada caso a caso, como foi para `parseChatId` (corpus exaustivo de 37.449 strings, com
controles negativos), e isso é trabalho próprio, não um apêndice.

**Refutadas por medição** (registradas para ninguém "consertar" fantasma):
`app/api/v1/channel-sessions/[id]/route.ts:171` — `/@.*/ ` **sem `$`** é linear (0,05 ms em
64 KB contra 4.481 ms da versão com âncora; o `$` é o defeito inteiro);
`lib/auth/provision.ts:11` e `lib/leads/stage-editing.ts:132` — a linha anterior colapsa a
corrida ou corta a entrada, então a regex nunca vê o caso ruim;
`lib/ai/rag/ingest/policy.ts:26` — o flag `/m` faz o match resolver cedo (0,25 ms em 200 KB).

---

## Não medido nesta rodada

- **Que os 12 alertas fecham de fato.** Isso exige uma varredura nova do CodeQL e uma do
  Dependabot depois do merge. O que está medido é a *causa* de cada um removida: o
  predicado `jobHasPermissions` satisfeito, a regex quadrática substituída por varredura
  linear equivalente, e o OSV a zero sobre o lock.
- **`allow: [{dependency-type: "all"}]` em `.github/dependabot.yml`.** O mecanismo que
  produziu o buraco continua de pé: o Dependabot não abriu PR para nenhuma das 6 transitivas
  em 4 a 8 dias, com `automated-security-fixes` ligado. Se essa opção mudaria o
  comportamento para pnpm é hipótese não verificável por CLI.
- **Um gate de auditoria de dependência no CI.** `pnpm audit` é barato mas comprovadamente
  cego (item 2 acima); `osv-scanner` cobre a classe mas põe uma action de terceiro num check
  obrigatório, e ambos ficam vermelhos quando sai GHSA novo sem mudança de código. É decisão
  de política de CI, não de patch.
