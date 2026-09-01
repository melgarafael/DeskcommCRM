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

## 3. AlternativeTo 🟢 pode ir agora

Exige conta no site. Sem custo, sem trava de idade.

- **Nome:** SonghaiCRM
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

## O que NÃO fazer

- **Não pagar por estrelas nem incentivar star com brinde.** Viola a Acceptable Use Policy do GitHub, e a medição é brutal: **90,42% dos repositórios com campanha de estrelas falsas foram deletados** pelo GitHub, contra 5,03% de baseline. O efeito positivo dura menos de dois meses e depois vira passivo.
- **Não fazer seeding coordenado no Reddit.** A moderação por IA detecta o padrão, a FTC trata endosso não divulgado como prática enganosa, e — o pior — threads denunciando astroturfing ranqueiam para a busca da marca e **persistem nas respostas de IA**. O tiro pela culatra também vira citação, permanente.
- **Não perseguir o GitHub Trending como meta.** Os critérios nunca foram publicados. O limiar de "30 a 40 estrelas em 1-2 horas" que o meio repete vem de **um post de blog de 2017 sobre um único repositório**.

---

*Última atualização: 28 de julho de 2026 — datas do awesome-selfhosted conferidas contra o template e os releases; `btw-so/open-source-alternatives` medido e descartado.*
