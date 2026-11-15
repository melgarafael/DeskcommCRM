---
type: doctrine
project: DeskcommCRM
---

# QA Visual com recursos reais

> Extraído **literalmente** do `CLAUDE.md` (seção «QA Visual com Recursos Reais — DOUTRINA (produto self-host)») para o arquivo de entrada caber no
> limite de 40k caracteres do Claude Code. O `CLAUDE.md` guarda a regra dura e aponta para cá;
> aqui mora o texto completo, com os motivos e as medições. Em divergência, vale **este** texto (é o original, copiado literalmente), e o resumo do `CLAUDE.md` é que se corrige.

**O DeskcommCRM é distribuído open-source: a experiência de quem instala numa VPS É o produto.** Toda feature nova (ou fix de comportamento visível) DEVE ser provada como um **usuário leigo a usaria de verdade** — pelo frontend, num ambiente que imita a instalação fresca — antes de "pronto". Não é opcional; é critério de aceite de toda sessão que toca UI ou fluxo de usuário.

**O que "recurso real" significa (e o que NÃO conta):**
- **Conta.** Prova pela tela, dirigindo o browser (Playwright), logando com conta de teste real. `curl`/chamada de API **não** provam UX — validam o backend, mas não o que o usuário vê, clica e entende. Use curl só como diagnóstico.
- **Banco fresco estilo VPS.** Postgres limpo aplicado do `supabase/baseline.sql` (não das `migrations/` — a cadeia fresh não sobe) + `scripts/bootstrap-owner.ts` (o que o `install.sh` faz). O ambiente do teste = o que o clone recém-instalado tem: sem os seus dados, sem os seus envs opcionais.
- **Dependências como na VPS.** WAHA local, Redis local (`redis` + `serverless-redis-http`), cron drain via endpoint. E **teste com os envs opcionais AUSENTES** (ex.: sem `RESEND_API_KEY`) — é o estado real de um primeiro deploy, e é onde moram os piores bugs de primeira impressão.
- **Efeito colateral externo provado com receiver real.** Webhook outbound, envio — suba um receiver HTTP de verdade e prove o que chegou (ou que foi barrado). Mock não estressa o egress real (anti-SSRF, projeção de payload, https em prod).

**Prioridade: primeira impressão acima de tudo.** Onboarding e as primeiras ações (criar conta, conectar canal, primeiro lead, primeiro convite) são a primeira impressão do usuário — bug ali é abandono. Teste esses caminhos primeiro e com o maior rigor.

**Registro obrigatório (senão o progresso é invisível):**
- Mapa de jornadas vivo em `docs/testing/user-journey-map.md` — casos por jornada, prioridade (`[P0]` primeira impressão), e achados. Atualize quando adicionar cobertura ou achar bug.
- Specs em `tests/e2e/*.spec.ts` que dirigem o **frontend** (não só API). Evidência visual (screenshot/trace) em `evidence/<entrega>/`, que é versionada; nunca em pasta que o `.gitignore` ignora, senão a prova não sai da sua máquina.
- Bug achado executando → **conserta na causa raiz**, com migration versionada se tocar schema (ver doutrina abaixo), commit próprio, e re-teste verde como prova.

**Medidas de front-end por ferramenta, nunca a olho** (`getBoundingClientRect`/`getComputedStyle` no Playwright). Ver `feedback_protocolo_execucao_visivel` na memória.

**Receita de ambiente fresco (não-óbvia):** banco = `baseline.sql` num Supabase local **pg15** (`config.toml major_version = 15`). Já foi pg17, por causa de 9 `GRANT MAINTAIN` que o `pg_dump` emitiu sozinho; hoje quem guarda o piso é `tests/unit/baseline-no-piso-do-postgres.test.ts`; `next build` + `next start` (produção — `next dev` compila lento demais e o Turbopack quebra `cookies()`); **worktree com `node_modules` real, nunca symlink** (Turbopack rejeita symlink "out of filesystem root") e **fora de `/tmp`** (é limpo no meio da sessão — commite cada marco). Detalhes em [[project_invite_e2e_and_bugs]].

---
