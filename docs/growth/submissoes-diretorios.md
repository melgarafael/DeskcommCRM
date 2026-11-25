# Submissões a diretórios

Diretórios de software open source são a alavanca de **GEO** mais subestimada do plano: a pesquisa mediu que **85,7% das citações que um LLM faz sobre uma marca apontam para domínios que ela não controla**, e esses diretórios estão entre os mais citados quando alguém pergunta "qual a melhor alternativa open source a X".

Não espere tráfego direto — não existe estudo público que quantifique visitas vindas de awesome-lists. O retorno é ser citável por terceiros.

---

## 1. awesome-selfhosted ⏳ bloqueado até 27/11/2026

**308,6 mil estrelas.** É o diretório de maior peso da categoria.

⚠️ **Não submeta ainda.** O template de PR exige literalmente:

> *"Any software project you are adding was first released more than 4 months ago."*

O repositório foi criado em **28/04/2026**. A v1.0.0 saiu em **27/07/2026**.

**Vale 27/11/2026, não 28/08.** A regra diz *released*, não *criado*, e é o release que o revisor consegue conferir sem sair da página: a aba Releases mostra uma única entrada, e em agosto ela ainda dirá "1 month ago". Reprovação ali não é privada — fica na thread do PR, indexada, no domínio de 308 mil estrelas, lida exatamente pelo público que queremos. Esperar quatro meses custa menos do que isso.

Não há como acelerar honestamente: o "primeiro release" é uma data fixa no passado. Cortar releases novas agora não move o primeiro.

**A vaga compensa a espera.** A tag `Customer Relationship Management (CRM)` tem hoje **dois** projetos — `django-crm` e `espocrm` —, e **nenhum** com WhatsApp (conferido em 28/07/2026). Não é uma prateleira lotada onde viraríamos mais um item.

**Como funciona:** a submissão **não** vai no README. Vai como um arquivo YAML em [`awesome-selfhosted-data`](https://github.com/awesome-selfhosted/awesome-selfhosted-data), em `software/deskcommcrm.yml`, um item por PR, nome de arquivo em kebab-case.

**Entrada pronta:** `docs/growth/awesome-selfhosted-deskcommcrm.yml`. É só copiar o conteúdo abaixo dos comentários. Os nomes de tag e plataforma foram conferidos em 28/07/2026 contra o campo `name:` de cada arquivo do repositório deles — **não** contra o nome do arquivo, que é diferente (`customer-relationship-management-crm.yml` declara `Customer Relationship Management (CRM)`). Referenciar pelo nome do arquivo é a rejeição mais comum.

Dois campos que o arquivo **não** leva: `stargazers_count` e `commit_history` são injetados por um bot deles depois do merge.

> `depends_3rdparty: true` está correto e é deliberado: o agente depende de um provedor de LLM externo. Declarar isso é exigência do diretório e, no nosso caso, é também coerente com a postura do projeto — omitir seria o tipo de meia-verdade que a doutrina do repo não admite.

**Checklist do PR deles** (todos precisam ser verdade no dia): um item por PR · projeto ativamente mantido · instruções de instalação funcionando · sem duplicata em issues/PRs abertos ou fechados · campos opcionais e comentários removidos.

---

## 2. opensourcealternative.to 🟡 decisão de custo

**Formulário web.** Campos: e-mail, site da alternativa, nome, repositório, site do software proprietário, nome do proprietário.

Critérios: ser open source · ser alternativa a um software proprietário · ativamente mantido · self-hosted. **Cumprimos os quatro.**

**A decisão é de custo:**

| | |
|---|---|
| **US$ 29** | revisão em 48 horas |
| **Grátis** | fila de 6+ meses |

**Recomendo pagar.** Seis meses de fila é longo demais para uma campanha, e este é um dos domínios que aparecem na primeira página quando se busca "best open source CRM" — ou seja, é material de citação para LLM, que é exatamente o que estamos comprando. US$ 29 é o item mais barato do plano inteiro.

**Como preencher** — submeter uma vez por concorrente, começando pelo de maior volume de busca:

| Software proprietário | Site |
|---|---|
| Kommo | kommo.com |
| Intercom | intercom.com |
| Octadesk | octadesk.com |

Nome da alternativa: `DeskcommCRM` · Repositório: `https://github.com/melgarafael/DeskcommCRM`

---

## 3. AlternativeTo 🟡 segurado

> **Atualização de 16/11/2026:** a FAQ da AlternativeTo exige que o app "support the English language", e a interface em inglês ainda está `em_construcao` em `lib/i18n/registro.ts`. A decisão (esperar o inglês ou listar declarando PT/ES) está com o Rafael no Plane.

Exige conta no site. Sem custo, sem trava de idade.

- **Nome:** DeskcommCRM
- **Categoria:** CRM / Customer Support
- **Licença:** Open Source (MIT)
- **Plataformas:** Self-Hosted, Web, Docker
- **Alternativa a:** Kommo, Intercom, Octadesk, HubSpot, Zendesk
- **Descrição:** *Open-source AI sales OS for WhatsApp. AI agents answer, qualify and move deals inside a CRM you host yourself. Multi-tenant with row-level security, LGPD by design, MIT-licensed with no paid tier.*

---

## 4. LibHunt 🟢 pode ir agora

Indexa automaticamente a partir do GitHub e aceita submissão. Sem custo.

**Caminho de submissão:** não existe um "adicionar projeto" avulso em evidência. O caminho documentado é abrir um projeto já listado que seja parecido, clicar em **Suggest alternative** e mandar a URL do nosso repositório. Existe também um formulário em `libhunt.com/site/project_submit`.

⚠️ **Expectativa calibrada:** o ranqueamento deles é movido por menções e atividade do repositório, não pela listagem. Estar lá, sozinho, move pouco. É um item barato de fazer, não uma alavanca.

⚠️ Os sites por categoria do LibHunt (incluindo `selfhosted.libhunt.com`) são espelhos de listas *awesome*. **Não confirmado** se o de self-hosted é gerado a partir do `awesome-selfhosted` — o site devolve 403 para automação e a sondagem não fechou. Se for, entramos lá de graça junto com o PR de novembro, e submeter agora é redundante. Conferir manualmente antes de gastar o esforço.

Os topics do repositório já estão saturados (20 de 20 usados), que é a fonte que eles leem.

---

## 5. Avaliados e descartados

Registrado para ninguém revisitar:

| Diretório | Por quê |
|---|---|
| [`btw-so/open-source-alternatives`](https://github.com/btw-so/open-source-alternatives) | **Abandonado.** 8,6 mil estrelas atraem, mas o último merge foi em **novembro de 2024** e há **37 PRs abertos** sem resposta desde então. A seção de CRM tem uma única entrada. PR ali é trabalho que ninguém lê. |
| `awesome-crm` | **Não existe** com peso relevante. A maior que leva esse nome tem 6 estrelas. |

---

## 6. Radar semanal

Toda segunda: as 10 buscas-alvo, as menções novas e as listagens desatualizadas. Para cada listagem velha fica pronto o pedido de correção a quem a mantém. **Quem envia** depende do canal: issue no GitHub sai pela conta do robô; formulário, "claim" com conta ou e-mail vai ao Plane para o Rafael.

### 2026-11-23 · main `3fb7bc7`, release v1.124.0 (23/11), 5.526 estrelas

**Origens do tráfego no GitHub (14 dias):** Google 3.238 · github.com 2.634 · youtube.com 1.387 · deskcomm.com.br 523 · Brave 74 · Bing 65 · l.instagram.com 43 · deskcomm.automatiklabs.com.br 25 · instagram.com 23 · perplexity.ai 12. Continua **sem nenhum diretório** entre as 10 primeiras origens. A perplexity.ai entra na lista: uma resposta de IA já manda gente ao repositório.

**Site:** `www.deskcomm.com.br/sitemap.xml` e `/llms.txt` continuam **404** (o apex responde 308 → www → 404). Os PRs que resolvem isso, deskcomm-site#17 (sitemap) e #18 (llms.txt), estão abertos e esperam o Rafael aprovar o CI e o deploy de fork. O `noindex` ainda está nos layouts.

**Buscas-alvo** (busca na web, 23/11):

| Busca | O DeskcommCRM aparece? | Mudou desde 16/11? |
|---|---|---|
| CRM open source | não | não (itsfoss, monday, Bitrix24, Capterra, EspoCRM) |
| CRM open source WhatsApp | não | não (Bitrix24, Odoo, Frappe, Krayin, wacrm em dev.co) |
| alternativa Kommo | não | não (AlternativeTo, respond.io, G2, Capterra) |
| alternativa Octadesk | não | não (InvGate, Capterra, G2, b2bstack, SocialHub) |
| CRM self-hosted | não | não (Bitrix24, NocoBase, Relaticle, Krayin, openalternative.co) |
| CRM com agentes de IA | não | não (Salesforce, folk, Breakcold, rework, Creatio) |
| open source CRM WhatsApp | não | não (igual à busca em português) |
| Kommo alternative open source | não | não (AlternativeTo, páginas 1 a 14) |
| self-hosted CRM AI agents | **sim**, agora pelo próprio repositório: `README.en.md` (raw.githubusercontent.com) | sim: antes só por terceiros (zentor.ai, opensourcealternatives.to) |
| CRM para clínica WhatsApp | não | não (Kommo, Clint, SocialHub, respond.io) |

Leitura: o README em inglês já ranqueia na busca em inglês sobre agentes. O site segue fora de todas: sem sitemap e com `noindex`, não tem como entrar.

**Menções e listagens** (conferidas em 23/11; nenhuma foi feita por nós):

| Onde | O que diz | Estado | Pedido de correção |
|---|---|---|---|
| everydev.ai | "latest GitHub release listed is v1.80.0" | ❌ continua velha (atual: v1.124.0) | Texto (A) da semana passada, com a versão trocada para v1.124.0 (23/11). Rafael, pelo contato do site. |
| Railway, template de Youssef Siam | `UPSTREAM.md` ainda fixado em v1.27.2; repositório sem push desde 15/09 | ❌ agora **112 releases** atrás (publicadas depois da v1.27.2, de 15/09 17:16Z, até a v1.124.0; a v1.27.3 saiu no mesmo dia e entra na conta) | Issue (B) pronta, **não aberta**: falta o OK pedido no Plane. Trocar no texto "v1.113.0 (2026-11-15)" por "v1.124.0 (2026-11-23)", "99" por "112" e "463" por "528" (arquivos `.sql` novos em `supabase/migrations/` entre v1.27.2 e v1.124.0). |
| zentor.ai/blog/deskcommcrm | v1.19.0, 1.382 estrelas, "a documentação pública não diz" quais modelos | ❌ sem mudança | Igual: opcional, baixa prioridade, sem contato editorial. |
| zekaiwork.com | categoria "E-commerce" | ❌ não deu para reconferir (403 para robô em 23/11) | Texto (C), sem mudança. |
| opentools.ai | 4.156 estrelas, ainda sem licença | ❌ sem mudança | "Claim Tool", com conta: Plane. |
| **novo:** [topai.tools/t/deskcomm](https://topai.tools/t/deskcomm) ("What is DeskComm?") | WhatsApp, agentes de IA, MIT, instalador de um comando; preço **"freemium"** | ⚠️ "freemium" está errado: não existe versão paga (o README só cita VPS e Supabase como custo) | Página bloqueia robô (403). Vai ao Plane: o Rafael confere se há rota de edição e, se houver, envia o texto (D). |
| **novo:** [productcool.com/product/melgarafael-deskcommcrm](https://www.productcool.com/product/melgarafael-deskcommcrm), 11/09 | MIT, grátis, custos só de VPS e chaves de IA | ✅ correto | Nenhum. O site é ligado a um serviço pago de submissão em massa (DirSubmit): **não** usar. |
| opensourcealternatives.to, ai-tldr.dev, provenlabs.ai, ai.miraheze.org | sem mudança desde 16/11 | igual | Igual. |

**Diretórios (frente 4)**

- **Glama:** continua não indexado (404 em 23/11). A decisão sobre o MCP embutido segue pendente.
- **`punkpeye/awesome-mcp-servers`:** nenhum PR (busca por "deskcomm", 23/11). Espera o Glama.
- **awesome-selfhosted:** nenhum PR em `awesome-selfhosted-data` (busca por "deskcomm", 23/11). A janela abre em 27/11 (primeira release v1.0.0 em 27/07). Quem escreve e abre é o Rafael (seção 1).

**Plane fora do ar**: o túnel recusa conexão desde 11/11 (`curl` 56 / HTTP 000 em 11, 16, 18, 19 e 23/11). Por isso nenhum pedido desta seção chegou ao Rafael. Os itens ficam prontos para criar quando ele voltar: "correções de listagens" (A, C, D, claim do opentools, OK para a issue B) e "Glama: indexar o MCP embutido?".

(D) topai.tools, para o Rafael enviar se houver rota:

> Hi — the DeskComm listing (topai.tools/t/deskcomm) shows the pricing as freemium. DeskcommCRM is fully free and open source under MIT, with no paid tier: the only costs are your own server and AI API usage. Source: https://github.com/melgarafael/DeskcommCRM. Could you change it to Free / Open Source? Thanks — Rafael (maintainer)

### 2026-11-16 · main `9dea1ee`, release v1.113.0 (15/11), 5.427 estrelas

**Origens do tráfego no GitHub (14 dias):** Google 3.801 · github.com 2.629 · youtube.com 1.862 · deskcomm.com.br 651 · Brave 101 · Bing 83. **Nenhum diretório** aparece entre as 10 primeiras origens.

**Buscas-alvo** (busca na web, 16/11; os resultados podem variar por região e conta):

| Busca | O DeskcommCRM aparece? | Quem ocupa a vaga |
|---|---|---|
| CRM open source | não | SuiteCRM, EspoCRM, Odoo, Frappe, Krayin (listas da monday, Bitrix24, itsfoss, openalternative.co) |
| CRM open source WhatsApp | não | Frappe CRM + app WhatsApp, Krayin, add-on do Odoo, wacrm, Chatwoot |
| alternativa Kommo | não | leadsales, respond.io, Capterra/G2/GetApp, AlternativeTo (`/software/amocrm/`) |
| alternativa Octadesk | não | InvGate, Talqui, G2, Capterra, b2bstack |
| CRM self-hosted | não | Bitrix24, Twenty, Relaticle, Krayin, NocoBase, selfhostyourself.com |
| CRM com agentes de IA | não | Salesforce Agentforce, folk, Breakcold, Creatio, rework |
| open source CRM WhatsApp | não | igual à busca em português |
| Kommo alternative open source | não | AlternativeTo (páginas 1 a 14 de `/software/amocrm/`), respond.io, stackshare |
| self-hosted CRM AI agents | **sim, por terceiros**: `zentor.ai/blog/deskcommcrm` e `opensourcealternatives.to/item/deskcommcrm` | Relaticle, Twenty, AgenticCRM (MIT, WhatsApp), Evo CRM |
| CRM para clínica WhatsApp | não | Clint, SocialHub, Kommo (páginas próprias de saúde) |

Leitura: o site não aparece em nenhuma das 10 buscas. Isso é coerente com o `noindex` que ainda está nos layouts do `deskcomm-site` (ver o PR semanal de SEO). Em "alternativa Kommo" e "Kommo alternative open source", a AlternativeTo ocupa a primeira página: entrar lá (seção 3) é o atalho mais curto para essas duas buscas.

**Menções e listagens encontradas** (nenhuma foi feita por nós):

| Onde | O que diz | Estado | Pedido de correção |
|---|---|---|---|
| [everydev.ai/tools/deskcommcrm](https://www.everydev.ai/tools/deskcommcrm) | "latest release v1.80.0" | ❌ velha (atual: v1.113.0) | Não há rota de edição visível na página. Vai ao Plane: o Rafael pede a atualização pelo contato do site. Texto abaixo (A). |
| [railway.com/deploy/deskcommcrm](https://railway.com/deploy/deskcommcrm), de Youssef Siam ([repo](https://github.com/youssefsiam38/deskcommcrm-railway)) | `UPSTREAM.md`: "Release pinned v1.27.2, published 2026-09-15"; 2 deploys; repo parado desde 15/09 | ❌ velha, com 99 releases de atraso (publicadas depois de 15/09) | Issue no repositório do template, pela conta do robô: texto abaixo (B). Não foi aberta ainda. |
| [zentor.ai/blog/deskcommcrm](https://zentor.ai/blog/deskcommcrm) (antes moclaw.ai), 12/09, editado 21/10 | v1.19.0, 1.382 estrelas; diz que "os provedores de modelo não aparecem na documentação pública" | ❌ velha, e esse ponto está errado: o README cita OpenRouter, Anthropic e OpenAI (linha 96) | Não há contato editorial, só redes sociais. Vai ao Plane como opcional, e de baixa prioridade. |
| [provenlabs.ai/journal/…](https://provenlabs.ai/journal/deskcommcrm-open-source-whatsapp-crm-kommo-intercom-alternative), 11/09 | v1.18.1, ~1,3 mil estrelas | artigo datado; os números eram verdade na época | Nenhum: artigo com data não se corrige. |
| [zekaiwork.com/free-open-source/deskcommcrm](https://zekaiwork.com/free-open-source/deskcommcrm/), set/2026 | 3.644 estrelas, **categoria "E-commerce"** | ❌ categoria errada (é CRM / atendimento) e números velhos | Pelo formulário de contato do site, ou seja, Plane. Texto abaixo (C). |
| [opentools.ai/tools/deskcommcrm](https://opentools.ai/tools/deskcommcrm), 28/09 | 4.156 estrelas, **sem licença** ("confira a licença") | ❌ falta a MIT | Botão "Claim Tool", que exige conta: Plane. |
| [opensourcealternatives.to/item/deskcommcrm](https://www.opensourcealternatives.to/item/deskcommcrm) | 5,4 mil estrelas, MIT, "alternative to HubSpot Sales Hub", conferido em 14/11 | ✅ em dia | Nenhum. Atenção: é um site **diferente** do `opensourcealternative.to` da seção 2. O link de deploy aponta para a Hostinger (afiliado deles), e não para a HostGator, que é a parceira. |
| [ai-tldr.dev/tools/deskcomm-crm](https://ai-tldr.dev/tools/deskcomm-crm/) | 5,4 mil estrelas, MIT, passos de instalação iguais aos do README | ✅ em dia | Nenhum. |
| [ai.miraheze.org/wiki/DeskcommCRM](https://ai.miraheze.org/wiki/DeskcommCRM), editado em 15/11 | artigo longo, **sem nenhuma referência** | ⚠️ não citado | Nenhum. Wiki sobre o próprio projeto não se edita (conflito de interesse). |

**Diretórios (frente 4)**

- **Glama:** o repositório **não está indexado** (`glama.ai/mcp/servers/melgarafael/DeskcommCRM` → 404, em 16/11). Não há API pública de submissão: o botão "Add Server" exige login. Além disso, o servidor MCP do DeskcommCRM é a rota `app/api/mcp/route.ts` dentro do app, com autenticação Bearer de um tenant. Ele não sobe sozinho, sem Supabase, então a inspeção automática que dá o selo de score provavelmente não consegue listar as ferramentas. Antes de submeter, é preciso decidir se vale a pena (vai ao Plane).
- **`punkpeye/awesome-mcp-servers`:** depende do Glama, e a lista aceita servidores "que você instala e roda". Nenhum PR nosso aberto ou fechado (busca por "deskcomm", 16/11). Fica para depois do Glama.

**Textos de correção prontos**

(A) everydev.ai, para o Rafael enviar:

> Hi — the DeskcommCRM listing (everydev.ai/tools/deskcommcrm) shows v1.80.0 as the latest release. The current release is v1.113.0 (2026-11-15): https://github.com/melgarafael/DeskcommCRM/releases. Could you refresh it? Thanks — Rafael (maintainer)

(B) Issue em `youssefsiam38/deskcommcrm-railway`, título "Upstream DeskcommCRM pinned to v1.27.2; current release is v1.113.0":

> Hi Youssef, thanks for packaging DeskcommCRM for Railway. `UPSTREAM.md` pins v1.27.2 (2026-09-15). Upstream is now at v1.113.0 (2026-11-15), and 463 database migration files were added since then, so a fresh deploy from this template starts 99 releases behind. Would you consider bumping the pin? `CHANGELOG.md` in the main repo lists what changed per release. Happy to answer questions about the upgrade path. — DeskcommCRM maintainers' bot (deskcomm-bot)

(C) zekaiwork.com, pelo formulário de contato, para o Rafael enviar:

> Hi — the DeskcommCRM page (zekaiwork.com/free-open-source/deskcommcrm/) files it under E-commerce. It is a CRM / customer-support tool (WhatsApp sales with AI agents); e-commerce is only one optional integration. Star count is also stale (3,644; now ~5.4k). Could you move it to CRM? Thanks — Rafael (maintainer)

---

## O que NÃO fazer

- **Não pagar por estrelas nem incentivar star com brinde.** Viola a Acceptable Use Policy do GitHub, e a medição é brutal: **90,42% dos repositórios com campanha de estrelas falsas foram deletados** pelo GitHub, contra 5,03% de baseline. O efeito positivo dura menos de dois meses e depois vira passivo.
- **Não fazer seeding coordenado no Reddit.** A moderação por IA detecta o padrão, a FTC trata endosso não divulgado como prática enganosa, e — o pior — threads denunciando astroturfing ranqueiam para a busca da marca e **persistem nas respostas de IA**. O tiro pela culatra também vira citação, permanente.
- **Não perseguir o GitHub Trending como meta.** Os critérios nunca foram publicados. O limiar de "30 a 40 estrelas em 1-2 horas" que o meio repete vem de **um post de blog de 2017 sobre um único repositório**.

---

*Última atualização: 23 de novembro de 2026: radar semanal (seção 6). Antes: 16 de novembro de 2026, radar semanal e AlternativeTo segurado; e 28 de julho de 2026 — datas do awesome-selfhosted conferidas contra o template e os releases; `btw-so/open-source-alternatives` medido e descartado.*
