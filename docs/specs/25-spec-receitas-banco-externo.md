# Spec 25 — Receitas prontas do banco externo: do WhatsApp ao funil (fase 2)

Status: **PROPOSTA**. Base CONFIRMADA na Spec 20, na Spec 23 e no código citado;
o resto é decisão proposta, não comportamento existente.

As referências ao código citam o símbolo; quando trazem linha, ela foi conferida
na main `330ead5ca` (16/10/2026) e pode andar com qualquer merge — procure pelo
símbolo. A convenção de origem `external` para pedidos (`external`, id
`<plataforma>:<id>`) é a da seção 1.79.0 do `CHANGELOG.md`.

Pré-requisito: Spec 23 (dialeto MySQL + fontes liberadas) aceita e mergeada.
Esta spec é a camada de produto em cima do motor — com duas revisões explícitas
à Spec 23, marcadas em "Revisões à Spec 23" (aceitas pelo mantenedor em 16/10/2026:
receitas por família no núcleo, dentro do módulo de banco externo, que nasce desligado), não reabertura
silenciosa.

## Objetivo

Um usuário leigo — dono de imobiliária no WordPress, lojista no WooCommerce,
lojista de carros num sistema PHP — conecta o banco, escolhe uma receita pronta,
e o agente passa a responder no WhatsApp com dados ao vivo ("3 apartamentos de
2 quartos na Asa Norte até 600 mil", um por mensagem, foto com legenda). Quando
o cliente mostra interesse, o agente joga a conversa para o funil e o
atendimento começa. É um CRM: leitura que não vira lead é vitrine.

O que muda em relação à Spec 23, em uma frase: a VIEW na origem deixa de ser o
caminho único e vira o modo avançado; o padrão passa a ser a receita pronta
(JOIN pré-escrito e revisado) + parâmetros preenchidos na tela e na conversa.

## Não medido (medir antes de implementar)

| # | O que não se sabe | Teste que mede |
|---|---|---|
| C1 | O dialeto real de cada família. ACF e JetEngine mudam entre versões: nomes de `meta_key`, formato de relacionamento (ID solto vs. serializado), tabelas próprias de relação. **NÃO MEDIDO**. | Integração contra cópia real de WP+ACF e WP+JetEngine (versões fixadas): roda cada receita e confere linhas, fotos e taxonomias. Receita que não passou aqui não é liberada. |
| C2 | Quanto custa uma resposta de receita em tokens (linhas × colunas × fotos). **NÃO MEDIDO** — INFERIDO que 3–4 imóveis com foto estouram o contexto se vierem inteiros. | Mede tokens por resposta em cada receita e fixa o teto de itens e de bytes por item a partir do medido. |
| C3 | O que o envio aceita por imagem via URL (tipo, tamanho, tempo). **NÃO MEDIDO**. | Envio real pelo adapter com as URLs das receitas (jpg/png/webp, até o teto da D7); registra aceito/recusado e o tempo. |
| C4 | Quantos itens por turno não irritam (2? 3?). O braço "4" está fora: exigiria mudar o knob de envios. **NÃO MEDIDO**. | Prova em par com gente de verdade: 2 e 3 itens; registra qual volume gerou resposta vs. silêncio. O desenho da prova resolve antes o orçamento de envios (I4 da revisão): a prova mede irritação, não o teto. |
| C5 | Por quanto tempo o rastro da execução guarda o resultado da receita e com que redação. **NÃO MEDIDO**. | Lê `lib/ai/runtime/serialize.ts:53-66` + retenção configurada; o achado vira regra explícita na D8. |
| C6 | Se URL de foto pode virar SSRF (foto apontando para IP interno). **NÃO MEDIDO**. | Teste com URL de foto para host interno: o envio deve recusar antes do fetch. |
| C7 | MariaDB. Segue fora, como na Spec 23 D1. | — |

## Decisões

| # | Tema | Decisão |
|---|---|---|
| D1 | Escopo da fase | Receitas prontas por família (padrão) + VIEW na origem (avançado) + foto por URL validada (proposta; a confirmação fica para o PR da parte que envia a foto) + ida ao funil via `crm_create_lead`. Sem SQL livre em v1. |
| D2 | Famílias da v1 | `woocommerce` (produtos/pedidos), `wordpress` (o **conteúdo de qualquer tipo de post** — imóveis, veículos, cursos, cardápio; ACF ou JetEngine modo padrão), `tabela-direta` (tabelas planas, coluna = dado; o JetEngine CCT é um **modelo** desta receita, não uma receita à parte). Sistema artesanal com relacionamento próprio: sem receita — cai no avançado (VIEW). |
| D3 | Onde a receita mora | Template + schema de parâmetros no **código** (versionado, revisado, sai no `update.sh`). A **instância** (receita X + parâmetros preenchidos na tela) é gravada no nosso Postgres, na linha da conexão (`jsonb`, RLS por org — mesma mecânica das `sources` da Spec 23 D3/Fatia 2a). Proposta de coluna nova segue a tripla (migration com `-- manifest:`, apêndice idempotente no `baseline.sql` com `add column if not exists`, colunas novas no FIM de qualquer lista de view, `revoke`/`grant` reemitidos se `_safe` mudar, sem linha no `MANIFEST.md`, `pnpm checar:colisao-de-migration`); tabela própria só pela função provisionadora da ADR-0002 — decisão do mantenedor. Precedente das `sources`: a coluna `receitas` fica **fora** da view `_safe` e das listas `COLUNAS_SEGURAS` (só contagem exposta); o array só é lido pelo servidor com `organization_id` no filtro. |
| D4 | Execução | Template + parâmetros validados (Zod) → placeholders ligados, nunca concatenação. Validador SELECT-only + tabelas permitidas antes de rodar. As tabelas do JOIN da receita passam pela mesma lista de fontes liberadas da Spec 23 D7, no mesmo ponto único de aplicação (`tabelaLiberada`/`colunasLiberadas`/`aplicarAoCatalogo` em `lib/external-db/fontes.ts`, aplicados em `criarDialetoPostgres`, `lib/external-db/dialeto.ts`): tabela fora da lista → `fonte_nao_liberada`; a receita nunca furta a lista. Execução na armadura do dialeto: transação só-leitura + timeouts (`lib/external-db/conexao.ts:127-147`, CONFIRMADO) e tetos (`max_rows`/`max_filters`/`max_response_bytes` em `lib/external-db/credenciais.ts`, truncagem de célula em `lib/external-db/leitura.ts:23`, teto de bytes da tool — CONFIRMADO). Nada da origem é persistido como entidade: o resultado volta ao turno e o que fica é o rastro da execução sob as regras da D8; auditoria sem valores (padrão de `dados-externos.ts:17-22`, CONFIRMADO). |
| D5 | ACF vs. JetEngine | Receitas separadas por família; o sistema **sugere** pela heurística (tabelas existentes + amostra de `meta_key`), a palavra final é do admin na tela. A heurística roda só no caminho de preview do admin (só-leitura); em empate (ambos presentes, restos de `meta_key` legados), sugere as duas e o admin escolhe. Nenhuma receita é liberada sem o C1 verde naquela família/versão. |
| D6 | Fluxo WhatsApp → funil | Até o teto do C4 (proposta inicial: **2** — o teto de envios por turno é 3, `DEFAULT_MAX_SENDS_PER_TURN` em `lib/agent-engine/agent/inbound-turn.ts`, CONFIRMADO, e cada item consome um envio; 4 itens exigem mudar o knob, fora da v1), um item por mensagem `send_message` (foto + legenda; diverge do padrão interno de N fotos numa mensagem em `lib/agent-engine/agent/fotos-do-produto.ts:100-111` — aqui um item = um interesse mapeável; o atrito com o anti-ban entra na prova). Interesse explícito → `crm_create_lead` (`lib/mcp/tools/leads.ts:236-260`, CONFIRMADO: `pipeline_id` + `stage_id` obrigatórios). Contrato PROPOSTO (decisão do mantenedor): `source: "external"`, referência em formato único `<familia>:<id>` (ex.: `acf:4821`) na `description` + nota no lead; funil/etapa de destino = padrão configurado na instância da receita (sem padrão, aviso na Central em vez de lead — item 4 do checklist); interesse repetido no mesmo item atualiza em vez de duplicar (regra de dedup por contato+referência, a desenhar na R5). |
| D7 | Foto por URL | Guarda canônica de fetch externo: `assertUrlDeMidiaSegura` (`lib/messaging/media/url-de-midia-externa.ts:34`, CONFIRMADO — textual + destino resolvido, com exceção do Storage assinado) + teto de tamanho + timeout do C3; C6 é o gate. Sem igualdade de host (banco `localhost`/contêiner vs. fotos no domínio/CDN — igualdade mataria o caso do leigo); sem a guarda canônica, sem envio. Falha de mídia nunca derruba o texto (manda sem foto e registra). Legenda herda `LIMITE_DA_LEGENDA = 1024` (`lib/agent-engine/agent/fotos-do-produto.ts:23-24`, CONFIRMADO): estouro sai como texto antes da foto. WhatsApp não tem "card": foto com legenda é o formato. |
| D8 | LGPD/rastro | O resultado da receita passa pelo rastro da execução (`ai_agent_runs.tool_calls`, redação por chave + corte — ponto levantado na triagem da #2527). A spec fixa: o que é redigido, o corte por campo e a retenção — explícitos antes da primeira fatia. |

## Regra de escopo da D8 (escrita na R1)

O que foi medido antes de escrever o código:

- `lib/ai/runtime/serialize.ts:16-29` (`redactValue`): redige só pelas chaves `authorization`, `api_key`, `token`, `password`, `cpf` e corta string longa em 500 + `...[truncated]`. **Não cobre** `email`, `telefone`, `endereço`, `hash` — e **não cobre** o campo `linhas` de uma consulta de banco externo. Uma linha de produto com preço, SKU, estoque e título passaria inteira para `ai_agent_runs.tool_calls`.
- `lib/ai/runtime/serialize.ts:53-76` (`serializeSteps`): grava `result: redactValue(result)` de cada tool. Se a tool `crm_consultar_receita` devolver as linhas, elas iriam para o rastro.
- `lib/retencao/politica.ts`: não há expurgo por tempo de `ai_agent_runs` (a migration 0587 purga sete outras tabelas sem tocar `ai_agent_runs`, conferido no arquivo dela). O que existe é a redação por contato (`fn_lgpd_redigir_tool_calls`, baseline :43935-43960), que deixa o esqueleto (`{step, tool_name, redacted}`) e tira o conteúdo.

A regra, escrita na R1:

> O rastro de `crm_consultar_receita` guarda os argumentos **sem os valores dos parâmetros de busca** (só os nomes) e o resultado **SÓ como contagem de linhas + colunas + `truncado`. Nenhuma linha da origem vai para o rastro.**

Como é implementado (não só no texto):

- `lib/ai/runtime/serialize.ts` ganhou o conjunto `RESULTADO_RESUMIDO` com a chave `linhas` (`serialize.ts:16-17`). Qualquer resultado de tool com uma chave nesse conjunto tem o array substituído por `[N itens resumidos pelo rastro]` (`serialize.ts:23-27`), nunca o conteúdo. Isso vale para `crm_consultar_receita` e para qualquer outra tool que devolva `linhas`.
- A tool `crm_consultar_receita` (`lib/mcp/tools/receitas-externas.ts`) devolve ao modelo as linhas já serializadas e truncadas pelo dialeto, mas no rastro (`serializeSteps`) o campo `linhas` é substituído pelo resumo — então o JSON serializado de `ai_agent_runs.tool_calls` **não contém nenhum valor de linha**.

Teste: `lib/ai/runtime/serialize.test.ts` usa um valor sentinela único (`__SENTINELA_WOOCOMMERCE_42__`) numa linha e prova que ele **não** aparece no JSON serializado de `serializeSteps`.

## Revisões à Spec 23 (aceitas pelo mantenedor em 16/10/2026)

Duas, explícitas — no precedente do bloco "Revisão da D6 da Spec 20" da própria
Spec 23:

1. **Código por família no núcleo.** A Spec 23 D2/D6 veda "conector WordPress"
   com `if` por provider e manda receita em docs. Templates JOIN por família em
   `lib/external-db/receitas/<familia>.ts` são código específico por provider no
   núcleo — evolução defensável (o JOIN revisado é o produto), mas revisão, não
   continuidade. Recusa possível: receitas como dados fora do núcleo — sem
   executor próprio, o que inviabiliza a D4; registrado aqui para a decisão ser
   informada.
2. **Consulta salva chega.** A Spec 23 pôs "consulta salva por fonte" em fora de
   escopo; a instância gravada (D3) é esse item chegando, restrito a templates
   revisados (sem SQL livre — esse continua fora).

## O fluxo do apartamento (caso de aceite)

1. Cliente no WhatsApp: "quero apê de 2 quartos na Asa Norte até 600 mil".
2. Agente executa a instância `wordpress-conteudo` da conexão com esses filtros, ao vivo, só-leitura.
3. Responde até 2 mensagens, uma por imóvel: foto + legenda (endereço, preço, quartos).
4. Cliente: "tenho interesse nesse segundo" → `crm_create_lead` (`source: "external"`, `acf:4821` na descrição + nota, funil/etapa padrão da instância) → atendimento segue no funil.
5. Mesmo roteiro vale para produto (WooCommerce) e carro (tabela direta).

## Superfície (proposta)

- `lib/external-db/receitas/<familia>.ts` (novo): template, schema de parâmetros, tabelas permitidas (incluindo as de taxonomia da família: `wp_terms`/`wp_term_taxonomy`/`wp_term_relationships` no WordPress, taxonomias do Woo onde couber — o ponto meta-vs-taxonomia decidido no C1 de cada família; a R2 do WordPress já resolve o ponto: a categoria entra na receita, e o administrador escolhe se o dado vem de campo ou de categoria), campo de foto, teto.
- Coluna `receitas jsonb` em `external_db_connections` (tripla) + validação Zod central (nunca path solto na UI — anti-pattern 6 do `CLAUDE.md`).
- Tool do agente `crm_consultar_receita` (descobrir instâncias + executar com params) + entrada no catálogo com `modulo: "banco_externo"` (defeito 1 da triagem da #2527 não se repete).
- `send_message` ganha `imagem_url` (opcional, sob as regras da D7); `produto_codigo` (catálogo interno, `inbound-turn.ts`, CONFIRMADO) continua como está.
- Tela em `/app/integracao-dados`: escolher receita, preencher parâmetros, marcar fontes, pré-visualizar (preview com dado real só para `admin` — `requireRole("admin")` — auditado por contagens, nunca valores; preview cruza as fontes ou declara a isenção).

## Fora de escopo

- Escrita no banco externo; SQL livre digitado pelo admin (futuro, com revisão e allowlist de tabelas).
- Sync contínuo para entidades do CRM; cópia de mídia para o nosso Storage.
- MariaDB; WP-REST/senha de aplicação (família HTTP futura, como na 23).
- Sistema artesanal com relacionamento próprio (modo avançado cobre).

## Testes e prova

- Unidade: validador SELECT-only (sabotagens: `INSERT`, `;--`, tabela fora da lista, parâmetro colado), render de cada template com params inválidos.
- Integração (MySQL/WP de verdade): C1 por família + C3 + C6.
- Isolamento: instância de outra org dá não-encontrada (lacuna 1 da triagem da #2527, aplicada aqui desde o dia 1).
- Prova em par (doutrina `docs/doctrine/prova-em-par.md`): C4 com gente + e2e do fluxo do apartamento (pergunta → 3 fotos → interesse → lead no funil com a referência externa).

## Ordem de entrega (um PR por fatia)

| Fatia | O que entrega |
|---|---|
| R1 | Receita `woocommerce` + instância + tool (sem foto, sem funil; exige a regra de escopo da D8 escrita) |
| R2 | Receita `wordpress-conteudo` (o conteúdo de QUALQUER tipo de post; exige C1 verde — medido em 21/10/2026) |
| R3 | Receita `jetengine-imoveis` (Custom Content Types) + `tabela-direta` |
| R4 | `imagem_url` no envio (exige C3/C6 verdes) |
| R5 | Ida ao funil (D6: contrato, padrão de destino, dedup) + e2e do apartamento |
| R6 | Runbook do leigo (a regra de escopo da D8 já entrou antes da R1) |

## Living System Checklist — receitas (resumo)

1. Nada é ilha: receita sem instância não aparece para o agente; instância sem fontes marcadas devolve `sem_fontes_liberadas`, nunca silêncio.
2. Continuidade humano↔IA: a grade mostra o mesmo que o assistente enxerga; o lead carrega a referência externa para o humano continuar de onde o robô parou.
3. Log universal e visível: execução auditada sem valores; mídia com falha registrada.
4. Nenhuma demanda sem próximo passo: interesse sem funil configurado vira aviso na Central, não buraco.
5. Informação com propósito: teto de itens/bytes do C2 — o modelo recebe o que cabe na decisão, não o banco.
6. Configuração com superfície: parâmetros em português na tela; nada de SQL à vista do leigo.
7. Todo laço se fecha: foto que não carrega, receita sem resultado e funil indisponível têm resposta e registro — os três.

## R1 entregue: o que mudou

A fatia R1 (receita `woocommerce` + instância + tool) entrega:

- `lib/external-db/receitas/tipos.ts` — `DefinicaoDeReceita` e `InstanciaDeReceita`
- `lib/external-db/receitas/woocommerce.ts` — receita `woocommerce-produtos` (JOIN posts+postmeta, parâmetros `termos`/`preco_max`/`so_em_estoque`/`limite`/`ordem`; cada termo aceita plural e busca também no resumo `post_excerpt`; teto = limite × termos, até 20)
- parâmetro `ordem` da receita `woocommerce-produtos`: `antigos` é o padrão; `recentes` vira `order by ID desc` e o `desc` é fixo no código, nunca vem do agente
- `lib/external-db/receitas/sql-mysql.ts` — `quotarIdentificadorMysql` e `escaparLikeMysql` em um só arquivo (crases e LIKE), reutilizado por todas as famílias de receitas; R2/R3 importam daqui
- `lib/external-db/receitas/registro.ts` — mapa `RECEITAS` e `receitaDe(id)`
- `lib/external-db/receitas/validador.ts` — `validarConsultaDeReceita` (SELECT-only, sem `;`/`--`/`INTO`/`SLEEP(`/etc., tabelas permitidas)
- `lib/external-db/receitas/instancias.ts` — `instanciaDeReceitaSchema`, `lerReceitasDoBanco`, `validarFixosDaReceita`
- `lib/external-db/dialeto.ts` — `Dialeto.executarReceita` + checagem `tabelaLiberada` no `criarDialetoDeLeitura`
- `lib/external-db/dialetos/mysql/dialeto.ts` + `leitura.ts` — `executarReceitaMysql` (armadura `consultarMysql`, serialização `0x`, corte por itens e bytes)
- `supabase/migrations/20261022120000_0706_banco_externo_receitas.sql` — coluna `receitas jsonb`, CHECK de forma, view `_safe` com `receitas_count`
- `supabase/baseline.sql` — apêndice idempotente da 0706 antes do fim
- `lib/external-db/receitas/instancias.ts` + rotas `PUT /recipes` e `POST /recipes/preview` (admin, audit só contagens)
- `lib/audit/actions.ts` — `external_db_recipes.updated` e `external_db_recipes.previewed`
- `lib/mcp/tools/receitas-externas.ts` — tool `crm_consultar_receita` (listar/executar, organização do `ctx`)
- `lib/mcp/tools/catalogo/receitas-externas.ts` + `index.ts` — entrada no catálogo com `modulo: "banco_externo"`
- `lib/mcp/tools/index.ts` — `crmConsultarReceita` em `allTools`
- `lib/ai/runtime/serialize.ts` — `RESULTADO_RESUMIDO` com `linhas` (regra D8)
- `app/app/integracao-dados/[id]/_components/ReceitasProntas.tsx` — seção "Receitas prontas" (só MySQL)
- `app/app/integracao-dados/[id]/page.tsx` — passa `db_type` e renderiza `ReceitasProntas`
- `lib/i18n/dicionario.ts` — entradas em espanhol dos textos novos
- `lib/hooks/external-db/useReceitasDaConexao.ts` — hook de leitura/salva/preview
- `docs/architecture/banco-de-dados-externo.architecture.json` — peças novas com ≥2 arestas
- `docs/threat-model.md` — entrada da superfície nova (preview + tool)
- `.changes/banco-externo-receitas-woocommerce.md` — `impacto: capacidade_nova`, `secao: adicionado`
- Testes: `validador.test.ts`, `woocommerce.test.ts`, `serialize.test.ts`, `receitas-externas.test.ts`, `dialeto.test.ts` (executarReceita não liberada), `apendice-0706-banco-externo-receitas.test.ts`
- Spec 25: seção D8 escrita e esta lista
- e2e: `tests/e2e/banco-externo-receitas.spec.ts` registrada em `SPECS_PARTE_1` do `.github/workflows/e2e.yml` (não rodada aqui — veredito do CI)

Destino: núcleo, dentro do módulo de banco externo, que nasce desligado (revisão 1 da Spec 25, aceita pelo mantenedor).

## R2 entregue: o conteúdo do WordPress, de qualquer nicho

A fatia R2 entrega a receita **`wordpress-conteudo`** — o conteúdo de um site
WordPress, de **qualquer tipo de post** — mais o modelo "Imóveis" e a tela que
monta a configuração.

### A decisão do dono (21/10/2026): a receita deixa de ser de UM nicho

**O que foi medido.** Num WordPress real — **ACF 6.8.10** (gratuito) +
**JetEngine 3.5.8**, MySQL **8.0.45** —, o cadastro típico de uma imobiliária
(16 imóveis) guarda **bairro e cidade só como CATEGORIA**: a taxonomia
hierárquica `localizacao` (Cidade › Bairro), mais `tipo_imovel` e
`finalidade`. O preço, o aluguel, os quartos e a situação são campos
(`meta_key`).

**O que a receita anterior devolvia: ZERO imóveis.** Quatro causas, todas
medidas:

| # | Causa | Efeito |
|---|---|---|
| 1 | o bairro era junção **obrigatória** e só vinha de `meta_key` | nenhum imóvel tinha o campo → a lista vinha vazia |
| 2 | o preço era junção **obrigatória** | imóvel só de aluguel (sem preço de venda) sumia |
| 3 | a situação **não era filtrada** | imóvel vendido era oferecido ao cliente |
| 4 | tipo e finalidade **não eram lidos** | a busca por "casa" ou "para venda" não filtrava |

**A decisão.** A receita vira **"Conteúdo do WordPress (qualquer tipo de
post)"**, e o administrador é quem diz o tipo de post, quais campos o site
guarda e de onde vem cada um. Três razões, todas escritas:

1. **Um site de veículos, de cursos ou de cardápio guarda os dados do mesmo
   jeito** (tipo de post + `wp_postmeta` + categorias) e não conseguia usar a
   receita: os campos de imobiliária estavam fixos no código.
2. **Uma receita de um nicho só tende a ser EXTENSÃO, não núcleo**
   (`docs/doctrine/extensoes.md`). O núcleo continua útil com zero extensões.
3. **O "Imóveis" continua existindo — como MODELO**: uma configuração que
   pré-preenche a tela (um clique), sem código de nicho na receita.

**O que a R2 preserva** (medido em 21/10/2026: 10 buscas certas em cada
cadastro realista, pelo motor e pela tela — Pré-visualizar): o LEFT JOIN por
campo (nenhum campo é obrigatório — o imóvel só de aluguel não tem preço de
venda), o `precoNumero`, a regra de nível filho/raiz, a finalidade por
**igualdade**, o "esconder", o `group_concat` (um imóvel com dois termos na
mesma taxonomia sai UMA vez), as tabelas de termo liberadas só quando há
categoria mapeada, e o campo apagado = chave removida.

### O contrato novo da receita `wordpress-conteudo`

**Fixos (o admin, na tela)** — `.strict()`, tudo validado por regex:

```
prefixo: string (default "wp_")
post_type: string
campos: Array<{
  chave: /^[a-z][a-z0-9_]{0,31}$/,
  rotulo: string (1..40),
  meta_key: /^[A-Za-z0-9_\-]{1,64}$/,
  tipo: "texto" | "numero" | "preco",
  filtro: "nenhum" | "contem" | "minimo" | "maximo"
}> (1..15)
categorias: Array<{
  chave: /^[a-z][a-z0-9_]{0,31}$/,
  rotulo: string (1..40),
  taxonomia: /^[a-z0-9_-]{1,32}$/,
  nivel: "qualquer" | "filho" | "raiz" (default "qualquer"),
  filtro: "nenhum" | "contem" | "igual"
}> (0..6)
esconder?: { meta_key: (regex), valores: string[] (1..10) }
```

Regras do Zod, com mensagem legível em português:

- a **chave** é única entre campos e categorias, e diferente de `id`,
  `titulo` e `link` — a saída já usa esses nomes;
- a **chave nasce do rótulo** (sem acento, minúscula, `_`): quem opera não
  digita a chave. Ela continua editável no "avançado" da tela, e um rótulo
  repetido não vira o mesmo dado duas vezes (`preco`, `preco_2`);
- filtro **`contém` só em `tipo: "texto"`**; **`mínimo`/`máximo` só em
  `numero`/`preco`** — um número não casa por pedaço de texto, e um texto não
  tem "mínimo";
- a **categoria** casa por `contém` (o pedaço do texto) ou por **`igual`**
  (o nome OU o slug, por igualdade — é o comportamento atual da finalidade);
- `esconder`: o `not exists` sobre o campo, com os valores a esconder.

**Busca (o agente)** — `.strict()`: `{ filtros?: Record<string, string|number>, limite?: 1..5 }`.
O teto continua 5.

O **conjunto de chaves depende da instância**, e essa é a parte nova:

- um filtro que a instância **não tem** é **ERRO legível**
  (`ErroDeFiltroDesconhecido`), nunca silêncio: devolver a lista inteira
  como se o filtro tivesse sido aplicado entrega ao cliente o que ele pediu
  para **não** ver;
- um filtro que a instância tem mas **não filtra** (o dado está mapeado sem
  filtro) também é erro — pelo mesmo motivo;
- o valor tem de ser do **tipo que o filtro pede**: número para `mínimo` e
  `máximo`, texto para `contém` e `igual`.

**Saída**: `id, titulo, <cada campo pela chave>, <cada categoria pela chave>,
link`. Sem foto (a `imagem_url` é a R4, como na R1).

**Os filtros que a instância aceita** entram na listagem da tool
`crm_consultar_receita`, derivados dos fixos: "filtros disponíveis: ano (Ano,
mínimo); marca (Marca, contém)". Sem essa linha, o agente chuta o nome do
filtro — e erra.

### O modelo "Imóveis" (só dados)

`lib/external-db/receitas/modelos-wordpress.ts` — o MODELO é **configuração**,
não código: ele pré-preenche a tela e nada mais. O "Em branco" é o outro
modelo (sem tipo de post sugerido: o site de cada pessoa o chama do jeito que
chama).

- **campos**: `codigo` (Código, texto, nenhum), `preco` (Preço de venda, preço,
  máximo), `aluguel` (Aluguel, preço, máximo), `condominio` (Condomínio, preço,
  nenhum), `quartos` (Quartos, número, mínimo), `suites` (Suítes, número,
  mínimo), `banheiros` (Banheiros, número, nenhum), `vagas` (Vagas, número,
  mínimo), `area` (Área, número, mínimo);
- **categorias**: `bairro` (Bairro, `localizacao`, filho, contém), `cidade`
  (Cidade, `localizacao`, raiz, contém), `tipo` (Tipo, `tipo_imovel`, qualquer,
  contém), `finalidade` (Finalidade, `finalidade`, qualquer, igual);
- **esconder**: `status_imovel` → vendido, alugado.

Os `meta_key` e as taxonomias são **sugestão**: o site de cada pessoa nomeia as
coisas do jeito dela, e o administrador ajusta na tela.

### A tela

`app/app/integracao-dados/[id]/_components/ReceitasProntas.tsx`:

- **"Adicionar receita" ESCOLHE a receita** (rótulo + descrição curta). O
  defeito era "adicionar" pegar a primeira da lista e criar sempre o
  WooCommerce. Editar uma instância salva **não** troca a receita — e a
  receita pode ter **várias** instâncias na mesma conexão (imóveis e veículos
  no mesmo site), então a lista não esconde mais as receitas já cadastradas;
- para a `wordpress-conteudo`: "Tipo de post", "Começar de um modelo"
  (Imóveis e Em branco — trocar só com confirmação se já houver algo
  digitado), a lista editável de **campos** (rótulo, campo no site, tipo,
  filtro; adicionar e remover) e a de **categorias** (rótulo, categoria no
  site, nível, filtro), e "Esconder itens" (campo + valores);
- a chave nasce do rótulo e é editável no "avançado";
- o 422 mostra o rótulo legível do caminho que falhou — agora com o **índice
  da linha** ("campos.1.chave"), para a tela saber qual dado corrigir.

### O que a R2 entrega (arquivos)

- `lib/external-db/receitas/wordpress-conteudo.ts` — a receita: o SQL, o Zod
  dos fixos e da busca, a validação dos filtros contra a instância e a
  descrição dos filtros;
- `lib/external-db/receitas/modelos-wordpress.ts` — o modelo "Imóveis" e o
  "Em branco" (só dados);
- `lib/external-db/receitas/erros.ts` — `ErroDeFiltroDesconhecido`;
- `lib/external-db/receitas/taxonomia.ts` — deixa de conhecer o conjunto fixo
  de categorias (a categoria passa a ser uma LISTA, com a chave e a taxonomia
  de cada uma);
- `lib/external-db/receitas/tipos.ts` — a família `wordpress` e o
  `descreverFiltros`;
- `lib/external-db/receitas/registro.ts` — a receita entra no registro;
- `lib/external-db/receitas/instancias.ts` — o motivo do Zod no 422 passa a
  trazer o índice da linha;
- `lib/mcp/tools/receitas-externas.ts` — a listagem mostra os filtros de cada
  instância, e um filtro inválido volta como erro legível;
- `app/app/integracao-dados/[id]/_components/ReceitasProntas.tsx` — a tela;
- `lib/i18n/dicionario.ts` — os textos novos em espanhol;
- Testes: `wordpress-conteudo.unit.test.ts` (o SQL de imóveis **E** de
  veículos, o Zod, os filtros, os erros), `instancias.unit.test.ts` (o caminho
  com índice), `receitas-externas-listagem.test.ts` (os filtros na listagem),
  `ReceitasProntas.wordpress.test.tsx` (a tela nova) e
  `tests/mysql/receita-wordpress-conteudo.test.ts` (MySQL 8 de verdade: a
  imobiliária e a loja de veículos, nos DOIS formatos — ACF com o par
  `_campo` e JetEngine no modo padrão com outro `post_type`);
- `.changes/banco-externo-receitas-wordpress-conteudo.md`.

Destino: núcleo, dentro do módulo de banco externo, que nasce desligado.

### A medição de 21/10/2026 (a que sustenta o contrato)

> **C1 (ACF) medido em 21/10/2026** contra WordPress 6.x + **ACF 6.8.10 (gratuito)** + MySQL **8.0.45**,
> tipo de post `imovel` e campos criados pela API do próprio ACF (`acf_import_post_type`,
> `acf_import_field_group`) e valores gravados com `update_field()` — o mesmo caminho da tela.
> Gravação real: cada campo vira o par `wp_postmeta` (`preco` = `650000`, `_preco` = `field_preco`), campo
> `number` guarda o número puro, `select` guarda a chave (`venda`). A receita do código foi executada pelo
> caminho de produção (`montar` → `validarConsultaDeReceita` → `executarReceitaMysql`) com um usuário MySQL
> com `SELECT` só em `wp_posts` e `wp_postmeta`, TLS `require`. 8 casos, todos com o resultado esperado:
> sem filtro (5 publicados; o rascunho não aparece), bairro `centro` (acha `Centro` e `centro`),
> `quartos_min` 3, `preco_max` 500000, cidade `votorantim`, bairro com `_` e `%` literais, bairro `_`
> sozinho (não vira curinga: 1 linha), `limite` 2. O ACF Pro não é necessário: a receita só lê campos
> simples.

> **JetEngine no modo padrão (tipo de post, CPT) medido no mesmo dia**, JetEngine 3.5.8: tipo de post
> `imovel_jet` e 6 campos criados pela tela do JetEngine; um imóvel salvo pela tela de edição do WordPress
> grava cada campo como linha simples em `wp_postmeta` (`preco` = `520000`, `imagem` = `17`, o id do anexo),
> igual ao ACF menos o par `_campo`. A mesma receita, com `post_type` = `imovel_jet`, acertou os mesmos 8
> casos (4 publicados, rascunho escondido). Por isso o rótulo é "Conteúdo do WordPress (qualquer tipo de
> post)": o id `wordpress-conteudo` cobre os dois. A receita `jetengine-imoveis` (R3) passa a ser só para
> Custom Content Types (CCT). Não medido: a opção "Custom Meta Storage (Beta)" do JetEngine, que guarda os
> campos numa tabela própria. Para a R4: no JetEngine a foto costuma ficar num campo de mídia próprio (id
> do anexo), não na imagem destacada — o campo da foto precisa ser escolhido pelo admin.

> **A C1 da CATEGORIA (21/10/2026)** foi medida no mesmo ambiente: as três tabelas de termo do WordPress
> (`wp_terms`, `wp_term_taxonomy`, `wp_term_relationships`) com a taxonomia `localizacao` hierárquica
> (Sorocaba › Centro; Votorantim › Centro). Com o bairro e a cidade lidos de CATEGORY, a receita acha o
> imóvel pelo bairro (`exists` sobre `term_relationships`), pelo nível (bairro = termo que tem termo
> acima; cidade = termo que não tem), e pela finalidade (nome **ou** slug do termo — a medição de 21/10
> casou por pedaço de texto; a entrega casa por **igualdade**, e a diferença está na limitação abaixo). O
> imóvel com DOIS termos na mesma taxonomia sai **uma** vez, com os dois nomes na mesma célula (`group_concat`).

**Limitações declaradas (medidas, não estimadas):**

- o filtro de um dado **não mapeado** não se aplica: a busca devolve o que tem,
  e o mapeamento incompleto é decisão do administrador (o Zod recusa a
  duplicidade de fonte, não a ausência);
- `link` vem de `wp_posts.guid`, que o WordPress **não** atualiza quando o site
  muda de domínio: o link do conteúdo continua apontando para o domínio antigo;
- `meta_key` repetido no mesmo post (base migrada) **repete o conteúdo** na
  lista: a receita faz uma junção por campo e não deduplica o post;
- a finalidade por categoria casa por **igualdade** do nome ou do slug: o termo
  tem de se chamar exatamente "Venda"/"Aluguel" (ou ter o slug "venda"/"aluguel").
  Um termo "Venda e Aluguel" **não** é "venda" nem "aluguel" — e nem "Locação".
  É de propósito: casar por pedaço de texto fazia o termo "Venda e Aluguel"
  entrar nas duas buscas, e o cliente recebia imóvel de finalidade errada.

O que a R2 **não** traz (e continua nas fatias seguintes): foto/`imagem_url`
(R4), JetEngine CCT e tabela direta (R3), ida ao funil e sugestão automática
de campos (R5), runbook do leigo (R6).

## R3 entregue: tabela direta (qualquer tabela plana) + modelo JetEngine CCT

A receita `tabela-direta` lê uma tabela plana do banco externo: uma linha =
um item, uma coluna = um dado. O administrador diz a tabela, a coluna do id,
a coluna do título, e mapeia cada dado (rótulo → coluna, tipo texto/número/
preço, filtro nenhum/contém/mínimo/máximo/igual). É o MESMO editor de
"Campos" da R2 (`CampoMapeado`, mesmas chaves reservadas, `chaveDoRotulo`/
`chaveUnica`, teto de itens 5), sem JOIN, sem taxonomia, sem categoria, sem
foto (é a R4). Opcional: "só mostrar quando <coluna> = <valor>" (ex.: `
cct_status = publish`) e "esconder quando <coluna> in <valores>" (ex.: `
situacao = vendido`).

O JetEngine CCT virou **modelo** desta receita ("JetEngine — tipo de conteúdo
próprio (CCT)"): preenche a tabela `<prefixo>jet_cct_<slug>`, o id `_ID`, a
coluna do título `titulo`, "só publicados" `cct_status = publish` e os campos
de imóveis. Não existe mais a receita `jetengine-imoveis` separada com campos
fixos: o CCT é um modelo da tabela-direta, e o modelo "Em branco" também
existe.

### O que mudou
- `lib/external-db/receitas/tipos.ts` — família `tabela-direta` adicionada a `FamiliaReceita`.
- `lib/external-db/receitas/tabela-direta.ts` — `RECEITA_TABELA_DIRETA` (id `tabela-direta`, família `tabela-direta`): Zod dos fixos e da busca, `tabelas()` = só a tabela informada, `colunas()` = as colunas mapeadas (trava das fontes/colunas liberadas — D4), `montar()` com `?` sempre, identificadores com `quotarIdentificadorMysql`, apelido de saída quotado, preço com `precoNumero`, filtro desconhecido = erro (mesmo padrão de `validarFiltrosDaBusca` da R2).
- `lib/external-db/receitas/modelos-tabela-direta.ts` — modelo JetEngine CCT (imóveis) e "Em branco".
- `lib/external-db/receitas/registro.ts` — a receita `tabela-direta` registrada no mapa de receitas.
- `app/app/integracao-dados/[id]/_components/ReceitasProntas.tsx` — "Adicionar receita" oferece as três receitas; editor da tabela direta com os mesmos componentes/estilo de Campos da R2 + tabela, coluna do id, coluna do título, "só mostrar quando" e "esconder quando"; modelo aplica com 1 clique e pergunta antes de apagar o que já foi digitado.
- `lib/i18n/dicionario.ts` — novas frases com tradução `es` (sem repetir chave).
- `lib/mcp/tools/receitas-externas.ts` e catálogo — a receita nova aparece com os filtros que a instância declarou (`descreverFiltrosDaInstanciaTabelaDireta`). D8 continua: o rastro só guarda contagem.
- `lib/external-db/receitas/tabela-direta.unit.test.ts` — unit (SQL, `?` = valores, quoting, filtro desconhecido, validador com e sem a tabela liberada, coluna não liberada recusada).
- `app/app/integracao-dados/[id]/_components/ReceitasProntas.tabela-direta.test.tsx` — tela (escolher receita, modelo CCT, editar, PUT).
- `tests/mysql/receita-tabela-direta.test.ts` — MySQL 8 de verdade: tabela CCT real (`_ID`, `cct_status`, `titulo`, `preco`, `quartos`, `bairro`, `cidade`, `area`, ...) e outra tabela de nicho diferente (`carros`); prova filtros, "só publicados", "esconder" e que bairro/cidade/quartos saem na linha.

### O que NÃO entra nesta fatia
- Foto/`imagem_url`: é a R4.
- Ida ao funil e sugestão automática de campos: é a R5.
- Runbook do leigo: é a R6.

Destino: núcleo, dentro do módulo de banco externo, que nasce desligado.
