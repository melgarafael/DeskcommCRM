# Spec 29 — O agente sabe o que a campanha vende

Status: **PROPOSTA**. Medido numa instalação 1.89.0 em produção, em 26/10/2026
entre 11h30 e 11h50 (Brasília), só leitura e filtrado por `organization_id`.
Referências conferidas na main `40db34708` (24/10/2026).

## O problema, em uma frase

A tela da campanha de prospecção tem "O que esta campanha vende" (Site
profissional, Automação do atendimento (CRM), Automações e integrações (N8N)),
mas o agente que atende as respostas **nunca fica sabendo** dessas escolhas, e a
estratégia que o sistema monta só usa a automação num caso estreito; o resultado
é a conversa oferecer só site mesmo com as três caixinhas marcadas.

## O que foi medido

- Caso real: campanha com `config.ofertas = ["site","automacao_crm","automacao_n8n"]`.
  A empresa abordada tem como site um Linktree (`classe = agregador`, cenário
  "Só rede social") e não tem nota nem número de avaliações no cadastro. Na
  resposta das 11h28 o agente ofereceu só site.
- **A estratégia ignora as ofertas fora de um caso.** `montarEstrategia`
  (`lib/prospecting/estrategia-site.ts`): `querAutomacao` só muda o ângulo
  dentro do ramo `classe === "site-ok"` **e** `numAvaliacoes >= 50` ("Site ok,
  demanda alta"). Nos ramos `agregador`/`sem-site`, `fora-do-ar`, inseguro,
  não-mobile, lento, construtor e "com problemas" o ângulo, os ganchos e as
  objeções são só de site, com qualquer combinação de ofertas.
- **O agente não recebe as ofertas.** A ferramenta
  `crm_get_prospecting_site_audit` (`lib/mcp/tools/prospeccao-site.ts`) devolve
  `estrategia_de_abordagem` (cenário, ângulo, ganchos, objeções, próximo passo)
  calculada com `campanha.ofertas`, mas não devolve a lista de ofertas. O
  contexto que o turno cola em toda resposta (`prospectingConversationContext`,
  `lib/prospecting/context.ts`) traz `instruction` e `qualification` da
  campanha e também não traz as ofertas.
- Hoje a única forma de o agente saber é o operador repetir as ofertas no texto
  livre da instrução — o que a tela não pede e ninguém faz por padrão.

## O que muda

### 1. As ofertas chegam ao agente

- `prospectingConversationContext` acrescenta uma linha com as ofertas marcadas,
  nos rótulos da tela, na ordem de prioridade: "O que esta campanha vende, em
  ordem: Site profissional; Automação do atendimento (CRM); Automações e
  integrações (N8N)." Campanha sem a chave = `["site"]` (o padrão de hoje).
- `crm_get_prospecting_site_audit` devolve `ofertas_da_campanha` (os mesmos
  rótulos) junto de `estrategia_de_abordagem`.
- Os rótulos saem de uma constante única ao lado de `OFERTAS_DA_CAMPANHA`
  (`lib/prospecting/schema.ts`), usada também pela tela, para os três lugares não
  divergirem.

### 2. A estratégia usa as outras ofertas em todo cenário

- `EstrategiaDoLead` ganha `complementar: string | null` — uma frase de ângulo
  para a oferta secundária. Preenchida quando a campanha vende automação
  (`automacao_crm` ou `automacao_n8n`) e o ângulo principal é de site, em
  qualquer classe: "Além do site, [o atendimento automatizado responde quem
  chama fora de hora / as automações tiram o trabalho repetido], sem trocar
  ninguém da equipe." O ramo "Site ok, demanda alta" continua igual (ali a
  automação já é o ângulo principal).
- Sem oferta de automação marcada, `complementar` é `null` e tudo fica como hoje.
- Quando site não está entre as ofertas selecionadas, a frase complementar fala
  só das automações marcadas, sem o prefixo "Além do site". Isso não altera o
  ângulo principal de site que o motor já calculava antes desta fatia.
- `complementar` sai na ferramenta (`estrategia_de_abordagem.complementar`) e na
  prévia da tela (`estrategiaDoCandidato`), que já bebem da mesma função.

## Fora desta spec

- O texto das skills e do prompt de cada organização (configuração).
- Mudar a régua de 50 avaliações do ramo "Site ok, demanda alta".

## Fatias (um PR, um commit por fatia)

1. `feat(prospeccao): o agente recebe o que a campanha vende` — constante de
   rótulos, contexto do turno, saída da ferramenta, tela lendo a constante.
2. `feat(prospeccao): a estratégia traz o ângulo da automação junto do site` —
   `complementar` em `montarEstrategia`, ferramenta e prévia.

## Como provar

- **Unit, com sabotagem:**
  - `prospectingConversationContext` com `ofertas` de três itens traz a linha
    com os três rótulos em ordem; sem a chave, traz só "Site profissional".
  - A ferramenta devolve `ofertas_da_campanha` igual à config.
  - Automação isolada e as duas automações sem site não anunciam site na frase
    complementar; todas essas combinações têm cobertura de espanhol.
  - `montarEstrategia` com `classe = agregador` e ofertas com automação traz
    `complementar` preenchido; só `["site"]` traz `null`; "Site ok, demanda
    alta" continua igual.
  - Isolamento: a ferramenta lê a campanha da conversa com `organization_id`
    (teste com duas organizações) — como já é hoje.
- **Pelo par agente × ferramenta:** na mesma conversa de teste, a ferramenta
  mostra `ofertas_da_campanha` e `complementar`, e a resposta do agente cita a
  automação em uma frase depois do site.

## Destino

**Núcleo.** Sem chave nova, sem migration, sem tela nova; campanha sem ofertas
marcadas se comporta como hoje.

— Paulo Lima Jr
