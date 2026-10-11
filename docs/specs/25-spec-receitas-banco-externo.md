# Spec 25 — Receitas prontas do banco externo: do WhatsApp ao funil (fase 2)

Status: **PROPOSTA**. Base CONFIRMADA na Spec 20, na Spec 23 e no código citado;
o resto é decisão proposta, não comportamento existente.

Linhas citadas medidas em 11/10/2026 no commit `6f2797d05` (branch
`fix/canal-desativado-quarentena`). A convenção de origem `external` para pedidos
(`external`, id `<plataforma>:<id>`) é a do tag `v1.79.0` (CHANGELOG do tag,
seção 1.79.0) — neste checkout o `CHANGELOG.md` vai até a `1.73.0`; nada da
v1.79.0 é afirmado a partir de código deste checkout.

Pré-requisito: Spec 23 (dialeto MySQL + fontes liberadas) aceita e mergeada.
Esta spec é a camada de produto em cima do motor — com duas revisões explícitas
à Spec 23, marcadas em "Revisões à Spec 23" (decisão do mantenedor), não reabertura
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
| D1 | Escopo da fase | Receitas prontas por família (padrão) + VIEW na origem (avançado) + foto por URL validada (opção A, decidida com o dono) + ida ao funil via `crm_create_lead`. Sem SQL livre em v1. |
| D2 | Famílias da v1 | `woocommerce` (produtos/pedidos), `acf-imoveis`, `jetengine-imoveis`, `tabela-direta` (tabelas planas, coluna = dado). Sistema artesanal com relacionamento próprio: sem receita — cai no avançado (VIEW). |
| D3 | Onde a receita mora | Template + schema de parâmetros no **código** (versionado, revisado, sai no `update.sh`). A **instância** (receita X + parâmetros preenchidos na tela) é gravada no nosso Postgres, na linha da conexão (`jsonb`, RLS por org — mesma mecânica das `sources` da Spec 23 D3/Fatia 2a). Proposta de coluna nova segue a tripla (migration com `-- manifest:`, apêndice idempotente no `baseline.sql` com `add column if not exists`, colunas novas no FIM de qualquer lista de view, `revoke`/`grant` reemitidos se `_safe` mudar, sem linha no `MANIFEST.md`, `pnpm checar:colisao-de-migration`); tabela própria só pela função provisionadora da ADR-0002 — decisão do mantenedor. Precedente das `sources`: a coluna `receitas` fica **fora** da view `_safe` e das listas `COLUNAS_SEGURAS` (só contagem exposta); o array só é lido pelo servidor com `organization_id` no filtro. |
| D4 | Execução | Template + parâmetros validados (Zod) → placeholders ligados, nunca concatenação. Validador SELECT-only + tabelas permitidas antes de rodar. As tabelas do JOIN da receita passam pela mesma lista de fontes liberadas da Spec 23 D7, no mesmo ponto único de aplicação (`aplicarFontes`): tabela fora da lista → `fonte_nao_liberada`; a receita nunca furta a lista. Execução na armadura do dialeto: transação só-leitura + timeouts (`lib/external-db/conexao.ts:127-147`, CONFIRMADO) e tetos (`max_rows`/`max_filters`/`max_response_bytes` em `lib/external-db/credenciais.ts:123-125`, truncagem de célula em `lib/external-db/leitura.ts:23`, teto de bytes da tool — CONFIRMADO). Nada da origem é persistido como entidade: o resultado volta ao turno e o que fica é o rastro da execução sob as regras da D8; auditoria sem valores (padrão de `dados-externos.ts:17-22`, CONFIRMADO). |
| D5 | ACF vs. JetEngine | Receitas separadas por família; o sistema **sugere** pela heurística (tabelas existentes + amostra de `meta_key`), a palavra final é do admin na tela. A heurística roda só no caminho de preview do admin (só-leitura); em empate (ambos presentes, restos de `meta_key` legados), sugere as duas e o admin escolhe. Nenhuma receita é liberada sem o C1 verde naquela família/versão. |
| D6 | Fluxo WhatsApp → funil | Até o teto do C4 (proposta inicial: **2** — o teto de envios por turno é 3, `DEFAULT_MAX_SENDS_PER_TURN` em `lib/agent-engine/agent/inbound-turn.ts:527`, CONFIRMADO, e cada item consome um envio; 4 itens exigem mudar o knob, fora da v1), um item por mensagem `send_message` (foto + legenda; diverge do padrão interno de N fotos numa mensagem em `lib/agent-engine/agent/fotos-do-produto.ts:100-111` — aqui um item = um interesse mapeável; o atrito com o anti-ban entra na prova). Interesse explícito → `crm_create_lead` (`lib/mcp/tools/leads.ts:236-260`, CONFIRMADO: `pipeline_id` + `stage_id` obrigatórios). Contrato PROPOSTO (decisão do mantenedor): `source: "external"`, referência em formato único `<familia>:<id>` (ex.: `acf:4821`) na `description` + nota no lead; funil/etapa de destino = padrão configurado na instância da receita (sem padrão, aviso na Central em vez de lead — item 4 do checklist); interesse repetido no mesmo item atualiza em vez de duplicar (regra de dedup por contato+referência, a desenhar na R5). |
| D7 | Foto por URL | Guarda canônica de fetch externo: `assertUrlDeMidiaSegura` (`lib/messaging/media/url-de-midia-externa.ts:34`, CONFIRMADO — textual + destino resolvido, com exceção do Storage assinado) + teto de tamanho + timeout do C3; C6 é o gate. Sem igualdade de host (banco `localhost`/contêiner vs. fotos no domínio/CDN — igualdade mataria o caso do leigo); sem a guarda canônica, sem envio. Falha de mídia nunca derruba o texto (manda sem foto e registra). Legenda herda `LIMITE_DA_LEGENDA = 1024` (`lib/agent-engine/agent/fotos-do-produto.ts:23-24`, CONFIRMADO): estouro sai como texto antes da foto. WhatsApp não tem "card": foto com legenda é o formato. |
| D8 | LGPD/rastro | O resultado da receita passa pelo rastro da execução (`ai_agent_runs.tool_calls`, redação por chave + corte — ponto levantado na triagem da #2527). A spec fixa: o que é redigido, o corte por campo e a retenção — explícitos antes da primeira fatia. |

## Revisões à Spec 23 (decisão do mantenedor)

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
2. Agente executa a instância `acf-imoveis` (ou `jetengine-imoveis`) da conexão com esses filtros, ao vivo, só-leitura.
3. Responde até 2 mensagens, uma por imóvel: foto + legenda (endereço, preço, quartos).
4. Cliente: "tenho interesse nesse segundo" → `crm_create_lead` (`source: "external"`, `acf:4821` na descrição + nota, funil/etapa padrão da instância) → atendimento segue no funil.
5. Mesmo roteiro vale para produto (WooCommerce) e carro (tabela direta).

## Superfície (proposta)

- `lib/external-db/receitas/<familia>.ts` (novo): template, schema de parâmetros, tabelas permitidas (incluindo as de taxonomia da família: `wp_terms`/`wp_term_taxonomy`/`wp_term_relationships` no WordPress, taxonomias do Woo onde couber — o ponto meta-vs-taxonomia decidido no C1 de cada família; v1 sem taxonomia sai com a limitação escrita), campo de foto, teto.
- Coluna `receitas jsonb` em `external_db_connections` (tripla) + validação Zod central (nunca path solto na UI — anti-pattern 6 do `CLAUDE.md`).
- Tool do agente `crm_consultar_receita` (descobrir instâncias + executar com params) + entrada no catálogo com `modulo: "banco_externo"` (defeito 1 da triagem da #2527 não se repete).
- `send_message` ganha `imagem_url` (opcional, sob as regras da D7); `produto_codigo` (catálogo interno, `inbound-turn.ts:245-258`, CONFIRMADO) continua como está.
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
| R2 | Receita `acf-imoveis` (exige C1 ACF verde) |
| R3 | Receita `jetengine-imoveis` (exige C1 JetEngine verde) + `tabela-direta` |
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
