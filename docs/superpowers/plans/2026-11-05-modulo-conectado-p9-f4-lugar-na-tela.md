# Módulo conectado — F4: lugar na tela — Plano de implementação

> **Para quem executa:** um subagente por tarefa, na ordem. Quem codifica não valida: o diff é lido por outra pessoa antes do commit seguir e o CI do GitHub é o juiz (nada de pnpm, vitest ou Docker local). Passos com caixa `- [ ]`.

**Meta:** o módulo conectado ganha lugar na tela do CRM: uma rota `/app/m/[modulo]` com a tela dele em iframe de outra origem, um grupo "Módulos" gerado no menu, um painel lateral opcional e uma conversa fechada por `postMessage`.

**Arquitetura:** o host é dono da moldura e o módulo é dono do conteúdo. O host nunca dá ao iframe cookie, token ou endereço livre. O iframe recebe contexto (caminho, idioma, tema, marca) e, quando pede, um JWT de contexto de 5 min (F3 T4). Tudo que o módulo pede ao host passa por uma lista fechada de 5 mensagens com origem conferida.

**Stack:** Next.js 16 App Router, React 19, TS estrito, Zod, `lib/navigation/*`, `lib/extensions/*`.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, seção F4 (D7 da ADR-0003). Depende de F1 (`service_origin` na entrada do catálogo) e F3 (rota `POST /api/v1/extensions/[id]/contexto`, `MODULE_JWT_PRIVATE_KEY`).

## Medido antes de escrever (05/11, branch `feat/modulo-conectado-f3`, topo `82e3af4bc`)

- `next.config.ts`: o host envia `X-Frame-Options: DENY` (só protege o CRM de ser enquadrado, não impede o CRM de enquadrar outro site), **não envia CSP** e envia `Permissions-Policy: microphone=(self)`. Um iframe de outra origem não herda o microfone: "microfone fica fora" já vale sem código. Nenhuma CSP nova entra nesta fase (declarado: o CRM não tem CSP hoje).
- Navegação: `NAV_CATALOG` é estático e `typedRoutes: true`. `sidebarGroups(platform, role, ?, ?, capacidades)` alimenta Sidebar e BarraInferior; `searchable(...)` alimenta o ⌘K (`components/shell/CommandPalette.tsx`). O grupo "Módulos" **não pode** ser uma entrada estática: é gerado em tempo de execução.
- `service_origin` mora na ENTRADA do catálogo revisado (F1), nunca no pacote. A Tarefa 1 localiza onde ficou gravado e relata o caminho exato.

## Restrições globais (valem em todas as tarefas)

- Lado seguro: qualquer dúvida não mostra o módulo e o CRM segue inteiro.
- Origem do módulo **nunca** igual à origem do CRM (`NEXT_PUBLIC_APP_URL`), por teste.
- `postMessage` do host usa sempre `targetOrigin = service_origin`, nunca `"*"`. Mensagem recebida só vale se `event.origin === service_origin` **e** `event.source === iframe.contentWindow`.
- O módulo nunca escolhe endereço: só um **id** do catálogo de navegação (`NavDestinationId`), que o host resolve e confere com `canSee`.
- Nada de token, JWT ou segredo na URL do iframe. Só `?organization=<uuid>&installation=<uuid>` (identificadores, sem poder).
- Textos novos em português simples com `t()` literal e entrada no dicionário `es`, `en.json` e `tr.json` (padrão da F2 T4 e F3 T5).
- Um commit por tarefa, em português, sem linha de atribuição.

## Foco da revisão (o que a spec implica e nenhuma tarefa testaria sozinha)

1. Mensagem de outra origem ou de outra janela com a mesma origem: ignorada em silêncio.
2. `module:navigate` com id inexistente, de tela que a pessoa não vê, ou com `href` no lugar de id: ignorado.
3. Módulo que nunca manda `module:ready`: o aviso aparece em 10 s e o resto da tela do CRM segue.
4. Módulo desativado, removido, fora da faixa `host_api` ou sem `service_origin`: nem aparece no menu, e `/app/m/<slug>` dá 404.
5. Pessoa que saiu da organização ou trocou de organização com a tela aberta: o JWT novo é recusado (F3) e o iframe recebe `host:error`.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/extensions/modulos-na-tela.ts` | fonte única: quais módulos conectados a organização pode abrir agora |
| `lib/modulo/ponte.ts` | lista fechada de mensagens, schemas Zod, conferência de origem (puro, sem React) |
| `components/modulo/QuadroDoModulo.tsx` | iframe + ponte + aviso de fora do ar (usado pela rota e pelo painel) |
| `app/app/m/[modulo]/page.tsx` | a rota |
| `components/modulo/PainelDoModulo.tsx` + botão no topo | painel lateral |
| `lib/navigation/registry.ts`, `components/shell/{Sidebar,BarraInferior,CommandPalette}.tsx` | grupo "Módulos" gerado e item no ⌘K |

---

### Tarefa 1: fonte dos módulos que aparecem na tela

**Files:** Create `lib/extensions/modulos-na-tela.ts` e `.test.ts`.

**Interfaces:**
- Produces: `type ModuloNaTela = { slug: string; titulo: string; icone: string; serviceOrigin: string; installationId: string }` e `modulosNaTela(organizationId: string): Promise<ModuloNaTela[]>` (servidor; admin client com filtro `organization_id` à mão, organização da sessão, nunca do corpo).

- [ ] Teste primeiro: devolve `[]` sem módulo; devolve só `profile === "connected"`, vínculo `enabled`, instalação sem `disabled_at`/`removed_at`, compatível com `HOST_API_VERSION` (`checkCompatibility`) e com `service_origin` presente e válido; recusa `service_origin` igual à origem do CRM; filtra por `organization_id` (organização B nunca aparece para A); erro do banco ⇒ `[]` (lado seguro).
- [ ] Implementar lendo as mesmas tabelas que `lib/auth/modulo-autorizado.ts` (com a FK explícita `extension_installations_artifact_id_fkey` no embed) e a entrada do catálogo onde a F1 gravou `service_origin`. Relate o caminho achado.
- [ ] `titulo` sai de `display.title` no idioma da pessoa, com o mesmo resolvedor localizado das extensões declarativas.

### Tarefa 2: a ponte `postMessage` (puro)

**Files:** Create `lib/modulo/ponte.ts` e `.test.ts`.

**Interfaces:**
- Produces: `MENSAGENS_DO_MODULO` (5 no total, fechadas):
  - módulo → host: `module:ready`, `module:request-jwt`, `module:navigate` `{ destination: string }`;
  - host → módulo: `host:context` `{ path, locale, theme, brand }`, `host:jwt` `{ jwt, expires_at }`, `host:error` `{ code }`.
- `lerMensagemDoModulo(evento: { origin: string; source: unknown; data: unknown }, esperado: { origin: string; janela: unknown }): MensagemDoModulo | null` — `null` para tudo que não passa.
- `mensagemParaOModulo(m: MensagemParaOModulo): string` (JSON validado, tamanho máximo 8 KB).

- [ ] Testes: origem diferente ⇒ `null`; mesma origem mas `source` diferente ⇒ `null`; tipo fora da lista ⇒ `null`; campo extra ⇒ `null` (Zod `.strict()`); `destination` com mais de 64 caracteres ou com `/` ⇒ `null`; dado que não é objeto ⇒ `null`; mensagem de saída acima de 8 KB lança.
- [ ] Implementar com Zod estrito e uma união discriminada por `type`.

### Tarefa 3: o quadro (iframe) e a rota

**Files:** Create `components/modulo/QuadroDoModulo.tsx`, `app/app/m/[modulo]/page.tsx` e testes de ambos.

**Interfaces:**
- Consumes: `modulosNaTela`, `lerMensagemDoModulo`, `mensagemParaOModulo`, `POST /api/v1/extensions/[id]/contexto`, `NAV_CATALOG`/`canSee`.
- Produces: `<QuadroDoModulo modulo={ModuloNaTela} />`.

- [ ] Teste: o iframe tem exatamente `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin"`, `referrerPolicy="no-referrer"`, `allow=""`, `src` = `serviceOrigin` + `/embed?organization=…&installation=…` e **nenhum** `jwt`, `token` ou `secret` na URL. (`allow-same-origin` refere-se à origem DO MÓDULO, que nunca é a do CRM: a Tarefa 1 garante.)
- [ ] Teste: ao receber `module:ready` envia `host:context`; ao receber `module:request-jwt` chama a rota de contexto e envia `host:jwt`; no máximo um JWT por 30 s (o pedido seguinte recebe `host:error` `{code:"rate_limited"}`); falha da rota ⇒ `host:error`.
- [ ] Teste: `module:navigate` com id de `NAV_CATALOG` visível à pessoa ⇒ `router.push(href)`; qualquer outro ⇒ nada.
- [ ] Teste: sem `module:ready` em 10 s, aparece o aviso "O serviço deste módulo não respondeu" e o resto da página continua.
- [ ] Rota: componente de servidor; sessão e organização por `requireRole("viewer")`; módulo pelo `slug` dentre `modulosNaTela(org)`; ausente ⇒ `notFound()`. Título da página = `titulo` do módulo.
- [ ] Reenvia `host:context` quando o caminho, o idioma ou o tema mudam.

### Tarefa 4: grupo "Módulos" gerado e item no ⌘K

**Files:** Modify `lib/navigation/registry.ts`, `components/shell/Sidebar.tsx`, `components/shell/BarraInferior.tsx`, `components/shell/CommandPalette.tsx`; Modify `tests/unit/navegacao-completude.test.ts` (justificativa escrita); Test novo `tests/unit/navegacao-modulos.test.ts`.

**Interfaces:**
- Produces: parâmetro opcional `modulos?: ModuloNaTela[]` em `sidebarGroups` e `searchable`; com lista vazia ou ausente, a saída é **idêntica** à de hoje.

- [ ] Teste: sem módulo, `sidebarGroups` e `searchable` devolvem exatamente o que devolviam (comparação com o resultado sem o parâmetro); com 2 módulos aparece um grupo "Módulos" com 2 itens `/app/m/<slug>`; slug com caracteres fora de `[a-z0-9-]` é descartado.
- [ ] A rota dinâmica entra na completude de navegação com **justificativa escrita** (rota gerada, uma entrada por módulo ativo), sem abrir exceção genérica.
- [ ] Sidebar e BarraInferior recebem `modulos` do layout do app (servidor busca uma vez por requisição; erro ⇒ lista vazia).

### Tarefa 5: painel lateral

**Files:** Create `components/modulo/PainelDoModulo.tsx` e teste; Modify o topo do shell (botão) e `CommandPalette.tsx` (item "Abrir <módulo> ao lado").

- [ ] Teste: o painel usa o **mesmo** `QuadroDoModulo` (um só caminho de segurança); abre um módulo por vez; `Esc` fecha; com um único módulo o botão abre direto, com vários abre a escolha; sem módulo o botão não existe.
- [ ] Em tela estreita o painel vira a rota `/app/m/<slug>` (sem layout novo).

### Tarefa 6: cercas, documentos e declarações

**Files:** `tests/unit/modulo-quadro-so-pela-ponte.test.ts` (cerca); `docs/testing/user-journey-map.md` (J70); `docs/architecture/extensoes-declarativas.architecture.json` (nós: `module_frame`, `module_bridge`, `module_nav_group`, `module_panel`, cada um com ≥2 arestas); `evidence/modulo-conectado-f4/declaracoes.md`; `.changes/modulo-conectado-tela.md` (`capacidade_nova`, `adicionado`; nenhuma ação do operador).

- [ ] Cerca por varredura: nenhum arquivo fora de `QuadroDoModulo.tsx` escreve um `<iframe` com origem de módulo, e nenhum `postMessage(` no repositório usa `"*"` como segundo argumento nos arquivos de `components/modulo/`.
- [ ] J70 com os casos do Foco da revisão, marcados "NÃO EXECUTADO" até haver módulo real; declarações: o que foi medido, o que **não** (módulo real, navegador de verdade, CSP, painel em celular), destino "núcleo + extensão (conector)", respostas do Sistema Vivo (alimenta: catálogo + ativação + consentimento; alimenta: a pessoa na tela; registro: audit já cobre as chamadas; tela: a própria; porta: grupo "Módulos" + ⌘K + painel; anti-morte: aviso de fora do ar; laço: `host:error` e o aviso visível ao admin).

## Autoverificação do plano

- Cobertura da spec F4: rota (T3), grupo gerado e sumindo sem módulo (T4), painel e ⌘K (T5), ponte com origem conferida nos dois lados e lista fechada (T2, T3), serviço fora do ar (T3), microfone fora (medido, sem código).
- Fora de escopo, declarado: CSP no CRM; eventos (F5); contrato congelado (F6); `host:resize` e qualquer outra mensagem fora da lista de 5.
