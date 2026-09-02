# Plano da Landing Page — deskcomm.com.br

> Plano de conteúdo, layout, narrativa e direção de arte. **Não é código.**
> Decisões travadas: hero **A Mesa Viva** · eixo **dono do negócio** com trilhas paralelas para dev.
>
> **2026-08-21 — parceria comercial com a HostGator encerrada.** A seção de banner de
> parceiro (§13, mantida abaixo riscada só para registro da decisão anterior) sai da
> página; a página termina em FOOTER logo após o FAQ (§12).

---

## 0. A tensão que precisa da sua decisão antes de tudo

O `docs/design-system/07-motion-language.md` proíbe, com essas palavras:

> ❌ **Parallax decorativo.** Hero scroll com 3 layers se movendo em velocidades diferentes. Não combina com soft-tech.

E você pediu exatamente camadas com motion no scroll. Não é contradição sua — é escopo: **aquele documento governa a aplicação**, onde o operador passa 8 horas e movimento gratuito vira cansaço. Uma página de venda é outro artefato, com outro trabalho.

**A reconciliação que proponho** mantém o espírito do documento, que é o que importa. Ele define quatro testes, e o primeiro é: *"Posso explicar o que essa animação comunica em uma frase? Se a resposta é 'fica bonito', remove."*

Então a regra da LP fica: **camada que se move precisa estar explicando o produto.** O lead atravessando a mesa se move porque **é isso que o lead faz**. A peça do agente acende quando o turno dele começa porque **é quando ele age**. Profundidade por profundidade — três planos deslizando em velocidades diferentes só para dar sensação de 3D — continua proibida, aqui também.

Na prática isso separa duas coisas que parecem a mesma:

| Permitido na LP | Continua proibido |
|---|---|
| Camada se move porque representa uma etapa real do sistema | Camada se move para dar sensação de profundidade |
| Estado muda quando o scroll chega no ponto que o explica | Elemento entra com fade só porque entrou no viewport |
| Movimento tem começo e fim ligados a um fato do produto | Movimento contínuo de fundo, decorativo |

**✅ APROVADO por Rafael em 27/07/2026.** Vira um documento novo — `docs/design-system/10-landing-motion.md` — declarando o escopo. Assim não é violação silenciosa da doutrina; é extensão registrada dela. O próprio `09-anti-patterns.md` diz que anti-patterns são o memory bank do design system e devem ser atualizados por PR.

---

## 1. Estratégia da página

### O funil, e por que ele não é linear

Os três objetivos não são um funil sequencial — são **três saídas** que a mesma página serve para pessoas diferentes:

| Objetivo | Quem faz | Onde a página oferece |
|---|---|---|
| ⭐ Star no repo | dev / técnico avaliando | header, bloco de prova, footer |
| 📦 Instalação na VPS | técnico ou revendedor | seções 9 e 10, CTA persistente |
| 💳 Assinatura da VPS | dono do negócio | banner final + CTA do hero |

A narrativa principal fala com **o dono do negócio**. Ele é quem paga a VPS, e a página é em pt-BR. O dev não é ignorado — ele tem um bloco inteiro feito para o ceticismo dele (§7), mas esse bloco não sequestra a história.

### Regra de ouro do conteúdo

Cada seção responde **uma** pergunta que o visitante realmente tem, nessa ordem: *o que é isso? · por que eu deveria me importar? · isso funciona mesmo? · serve pro meu caso? · como eu começo? · quanto custa?*

Seção que não responde nenhuma delas sai do plano.

---

## 2. Restrições não-negociáveis

**Do design system** (`09-anti-patterns.md`):
Atkinson Hyperlegible + IBM Plex Mono · sem Inter/Geist · **sem gradiente roxo/azul/rosa** · botão primário sólido verde-WhatsApp `#169b80` · sem glassmorphism · Phosphor duotone (nunca Lucide, nunca ícone Sparkles para IA — usar `Brain`) · fundo `#faf9f6`, nunca branco puro · sombras `rgba(20,18,14,X)`, nunca preto puro · sem `transition: all`.

**Do GEO** (pesquisa de 27/07):
Renderização no servidor obrigatória — **nenhum crawler de IA executa JavaScript**. Todo o conteúdo textual existe no HTML servido; o scrollytelling é camada por cima. `<html lang="pt-BR">`, `og:locale=pt_BR`, hreflang no `<head>`. Data de atualização visível na página.

**De performance:**
As camadas animam só `transform` e `opacity` (GPU). Imagens em AVIF com fallback WebP. Só o hero tem prioridade de carregamento; o resto é lazy. Orçamento: LCP < 2,5s no 4G.

**De acessibilidade:**
`prefers-reduced-motion` cai para o estado final estático de cada cena — a página continua contando a história inteira sem nenhum movimento. Toda imagem tem `alt` que descreve o **fato**, não a estética.

---

## 3. Estrutura da página

```
HEADER (sticky, fino)
 ├─ 1. HERO — A Mesa Viva
 ├─ 2. O problema — dois vilões nomeados
 ├─ 3. A virada — Sistema Operacional Comercial Vivo
 ├─ 4. SCROLLYTELLING — A vida de um lead        ◄ peça central
 ├─ 5. Como o sistema pensa — o turno do agente  ◄ vista explodida 3D
 ├─ 6. Nada morre — o Radar e o follow-up
 ├─ 7. Prova — bloco técnico (trilha do dev)     ◄ CTA de star
 ├─ 8. Um núcleo, N nichos
 ├─ 9. Para quem instala para clientes
 ├─ 10. Instalação — um comando
 ├─ 11. Quanto custa — honestidade como argumento
 ├─ 12. FAQ citável
FOOTER
```

---

## HEADER

Fino, sticky, fundo `#faf9f6` com `border-bottom` de 1px que só aparece após 40px de scroll.

```
[■ SonghaiCRM]     Como funciona · Prova · Instalar · Preço      [GitHub ⭐] [Instalar na VPS]
```

- `[GitHub ⭐ 116]` — secundário, ghost, **com contador ao vivo**. Decisão do Rafael, contra minha recomendação inicial e com argumento melhor que o meu: 116 para um CRM brasileiro com 3 meses de vida lê como tração real, não como hobby — a régua de ~1k que a pesquisa usa é de projeto anglófono de infraestrutura, outro mercado. O número é buscado da API do GitHub e cacheado; nunca hardcoded (prova social escrita à mão apodrece e fica menor que a realidade).
- `[Instalar na VPS]` — primário sólido verde-WhatsApp.
- Mobile: logo + botão primário; o resto vira menu.

---

## 1. HERO — A Mesa Viva

### O conceito

O nome do produto virando imagem. **Deskcomm = Desk + comm — o comercial de mesa.** O hero é uma mesa isométrica vista de cima, onde a operação comercial inteira é **uma superfície só**: a conversa, o funil, o agente, o follow-up — peças distintas ligadas por trilhas visíveis.

Por que isso é a escolha certa e não outra: é a única imagem desta página que **nenhum concorrente pode usar**, porque ela nasce da etimologia do seu nome. Um CRM genérico pode mostrar um kanban. Nenhum pode mostrar "a mesa".

E ela carrega a tese sem precisar dizê-la: se tudo está na mesma mesa e as peças estão ligadas, **nada cai no chão**. É o "sistema vivo" como fato visual, não como adjetivo.

### Layout

Assimétrico, não centralizado. Copy à esquerda ocupando ~42%, mesa à direita sangrando para fora da margem — sugere que a mesa continua além da tela.

```
┌──────────────────────────────────────────────────────────────┐
│  Desk + comm                                                  │
│  ─────────────                            ╱▔▔▔▔▔▔▔▔▔╲        │
│                                        ╱   ▢     ▢   ╲       │
│  Sua operação comercial                │  ╲   ╱ ╲   ╱ │      │
│  numa mesa só.                         │   ▢─────▢    │      │
│  E nada morre em cima dela.            │  ╱   ╲ ╱   ╲ │      │
│                                        ╲   ▢     ▢   ╱       │
│  Agentes de IA atendem no WhatsApp,     ╲▁▁▁▁▁▁▁▁▁▁▁╱        │
│  qualificam e movem o funil — no                              │
│  seu servidor, sem mensalidade.        ● lead entra           │
│                                                               │
│  [Instalar na VPS]  [Ver no GitHub]                          │
│  MIT · sem plano pago · roda em 2 GB                         │
└──────────────────────────────────────────────────────────────┘
```

### Copy

> **Eyebrow:** `Desk + comm — o comercial de mesa`
>
> **H1:** Sua operação comercial numa mesa só.
> **E nada morre em cima dela.**
>
> **Sub:** Agentes de IA atendem no WhatsApp, qualificam o lead e movem o funil — com tudo registrado e auditável. No seu servidor, sem mensalidade por usuário.
>
> **CTA primário:** Instalar na minha VPS
> **CTA secundário:** Ver o código no GitHub
> **Microcopy:** Licença MIT · sem versão paga · roda numa VPS de 2 GB

A segunda linha do H1 é a frase que ancora a categoria. Ela vem da doutrina (`sistema-vivo.md`) e é a única promessa desta página que os concorrentes **não conseguem repetir sem mentir**.

### Camadas e motion

Cinco PNGs empilhados, ordem de baixo para cima:

| # | Camada | Comportamento |
|---|---|---|
| 1 | Tampo da mesa (sombra + superfície) | estático |
| 2 | Trilhas de conexão entre as peças | acendem em sequência ao entrar (uma vez) |
| 3 | Peças: conversa, funil, agente, follow-up, log | estáticas |
| 4 | Rótulos flutuantes das peças | fade + 8px rise, stagger 50ms |
| 5 | O lead (um ponto verde-WhatsApp) | percorre a trilha da conversa até o funil |

**Movimento no scroll:** a câmera **não** faz parallax de profundidade. Ela faz uma coisa só e explicável: conforme o scroll desce, a mesa **inclina levemente** (de ~18° para ~12° de isometria), como quem se aproxima para olhar de perto. Uma frase: *"você está chegando mais perto da mesa"*. É a transição para a §4, que acontece **em cima da mesma mesa**.

`prefers-reduced-motion`: mesa no ângulo final, trilhas acesas, lead posicionado no meio do caminho. História inteira, zero movimento.

---

## 2. O PROBLEMA — dois vilões nomeados

Não comparamos com produto nenhum. Nomeamos **duas situações** que o visitante reconhece na própria operação. Isso reposiciona o concorrente de "outro CRM" para "o jeito que você trabalha hoje" — e ninguém defende o jeito que trabalha hoje.

> **Título:** Você não perde venda por falta de lead.
>
> **Vilão 1 — O CRM que é planilha bonita.**
> O lead entra, alguém cadastra, e nada acontece. Quando você percebe, ele sumiu — e ninguém sabe dizer em que momento, nem por quê. O sistema guardou o nome dele e perdeu a história.
>
> **Vilão 2 — O robô que responde e some.**
> Atende rápido, responde qualquer coisa, e some. Se prometeu prazo que não existe, você descobre pelo cliente. Não dá para auditar o que ele disse, e muito menos por que ele disse.
>
> **A virada:** Os dois têm a mesma raiz: o sistema não é responsável pelo que acontece depois.

Layout: duas colunas, cada vilão com uma ilustração 3D pequena (ver §Imagens: `viloes-01`, `viloes-02`). Sem ícones genéricos.

---

## 3. A VIRADA — Sistema Operacional Comercial Vivo

Aqui a categoria é nomeada e — crucialmente — **definida por critérios que dá para verificar**. Categoria sem critério é adjetivo; com critério, é padrão.

> **Título:** Um sistema operacional comercial **vivo**.
>
> **Sub:** Vivo tem definição, e a definição está escrita no repositório antes de estar nesta página. São cinco regras que toda parte do sistema precisa cumprir:

Cinco itens, cada um com um mini-diagrama e a formulação verificável:

| # | Regra | Como se verifica |
|---|---|---|
| 1 | **Nada é ilha** | toda peça tem entrada e saída — o mapa de arquitetura é público |
| 2 | **Nenhum lead morre sem diagnóstico** | demanda parada aparece no Radar classificada por risco |
| 3 | **Toda ação da IA é auditável** | 7 verificações por envio, cada uma vira registro — inclusive as que barram |
| 4 | **Log invisível é log morto** | toda mutação relevante vira atividade na linha do tempo, na tela |
| 5 | **Follow-up é o anti-morte** | demanda aberta sem próximo passo é tratada como vazamento |

> **Fecho:** Isso não é o que a gente promete. É o critério que uma mudança precisa passar para entrar no sistema — está em `docs/doctrine/sistema-vivo.md`, e o checklist de sete perguntas é respondido antes de cada merge.

---

## 4. SCROLLYTELLING — A vida de um lead ◄ peça central

**A seção mais importante da página.** É onde as promessas viram algo que o visitante *vê acontecer*.

Formato: **imagem fixa (sticky) à direita, texto rolando à esquerda.** O visitante desce, e a mesma cena da mesa muda de estado a cada bloco de texto. Uma cena, sete estados.

Por que sticky em vez de sequência de imagens soltas: mantém a continuidade espacial que o design system valoriza — a mesa não some e volta, ela **evolui**. É a mesma mesa do hero, agora vista de perto.

### Os sete beats

| # | Texto (esquerda) | O que muda na cena (direita) |
|---|---|---|
| 1 | **09:41 — chega uma mensagem.** "Vocês entregam em Salvador?" Antes de qualquer resposta, o sistema já sabe quem é: histórico, pedidos, o que ficou combinado da última vez. | Peça da conversa acende. Um cartão de contexto sobe ao lado com os dados do contato. |
| 2 | **O agente lê antes de falar.** Ele busca na base de conhecimento **da sua empresa** — seu prazo, sua política, seu catálogo. Não inventa. | Linha ligando o agente à peça da base de conhecimento; documentos acendem em sequência. |
| 3 | **Sete verificações antes de enviar.** Descadastro, LGPD, anti-banimento, variação de texto, promessa determinística, promessa semântica, aviso de automação. Nessa ordem, sempre. | Sete pequenos gates aparecem em fila. Seis passam em verde; **um barra em âmbar** e a mensagem volta. |
| 4 | **Inclusive o que ele decidiu NÃO enviar.** O agente ia prometer entrega em 24h. A verificação de promessa barrou: esse prazo não existe no seu catálogo. Fica registrado o que ele ia dizer e por que não disse. | Zoom no gate âmbar; um registro se materializa com a razão da recusa. |
| 5 | **O lead se move sozinho.** Qualificado, ele muda de etapa no funil. A etiqueta entra, o responsável é definido — e cada movimento tem motivo registrado. | O ponto do lead percorre a trilha até a peça do funil e assenta numa coluna nova. |
| 6 | **Quando é hora do humano, ele recebe contexto — não a conversa crua.** Resumo do que aconteceu, o que foi combinado, quais objeções apareceram e qual é o próximo passo. | A peça do agente passa o bastão para a peça do atendente; um cartão de resumo transita entre elas. |
| 7 | **E se ninguém responder, o sistema não deixa morrer.** Follow-up agendado. Se esfriar, o lead aparece no Radar classificado por risco — antes de virar prejuízo. | Peça do follow-up acende; um contador de tempo começa; o lead ganha um anel âmbar de "em risco". |

**Motion:** cada mudança de estado é `opacity` + `transform` de uma camada, disparada quando o bloco de texto correspondente entra na área central da viewport. Nada se move continuamente. Nada se move sem que o texto ao lado explique o que aquilo é.

`prefers-reduced-motion`: vira uma pilha vertical — cada beat com sua imagem de estado final, sem sticky, sem transição.

**Mobile:** sticky não funciona bem em telas pequenas. Vira sequência: texto, imagem, texto, imagem. A história é a mesma.

---

## 5. COMO O SISTEMA PENSA — o turno do agente

Aqui entra a **vista explodida 3D** — a peça que satisfaz o "ver como o sistema pensa".

> **Título:** O que acontece entre a pergunta e a resposta.
>
> **Sub:** Não é uma chamada para um modelo de IA. É um turno com etapas, e cada uma deixa rastro.

Uma peça 3D explodida em camadas horizontais empilhadas, cada uma rotulada, com as conexões visíveis entre elas:

```
        ╔═══════════════════════╗
        ║  MENSAGEM CHEGA       ║
        ╚═══════════╤═══════════╝
        ╔═══════════▼═══════════╗
        ║  CONTEXTO             ║  histórico + contato + funil
        ╚═══════════╤═══════════╝
        ╔═══════════▼═══════════╗
        ║  CONHECIMENTO         ║  busca na base da SUA empresa
        ╚═══════════╤═══════════╝
        ╔═══════════▼═══════════╗
        ║  DECISÃO              ║  responder · mover · escalar
        ╚═══════════╤═══════════╝
        ╔═══════════▼═══════════╗
        ║  7 VERIFICAÇÕES       ║  ◄ pode vetar e devolver
        ╚═══════════╤═══════════╝
        ╔═══════════▼═══════════╗
        ║  ENVIO + REGISTRO     ║
        ╚═══════════════════════╝
```

**Motion:** ao entrar na viewport, as camadas se separam verticalmente (a "explosão") **uma vez**, em 320ms com a curva `ease-out-slow` do design system. Depois ficam paradas. Um pulso desce pelas conexões, uma vez, mostrando o percurso.

Detalhe que vale a pena: a seta da camada de verificações **volta** para a decisão. É o veto instrutivo — o gate não só barra, ele devolve a razão ao modelo. É um fato do código (`lib/agent-engine/guardrails/before-send.ts`) e quase nenhum produto pode desenhar isso.

---

## 6. NADA MORRE — o Radar

Seção curta e de alto impacto, ancorando o invariante mais vendável.

> **Título:** A pergunta que nenhum CRM responde: **quantos leads estão morrendo agora?**
>
> **Corpo:** O Radar responde. Toda demanda aberta é classificada — **crítico**, **em risco**, **em voo** — pelo tempo sem interação e pelo que ficou pendente. Não é relatório do mês passado; é o estado agora.
>
> **Fecho:** Um número na tela que não muda uma decisão é ruído. Esse muda.

Imagem: composição 3D do Radar com três anéis concêntricos, leads distribuídos por faixa de risco.

---

## 7. PROVA — o bloco do dev ◄ trilha paralela

Deliberadamente técnico e denso. O dono do negócio pula; o dev cético para aqui. É também o bloco mais citável por LLM, porque é onde moram os números verificáveis.

> **Título:** Não acredite. Confira.
>
> Quatro cartões, cada um com o caminho no repositório:

| Afirmação | Onde conferir |
|---|---|
| **Isolamento entre clientes é testado a cada alteração.** O CI sobe um Postgres limpo e roda 364 testes de invariante. Um deles cria duas organizações e prova que uma não vê nenhuma linha da outra — e um caso de controle prova antes que as linhas existem, senão o teste passaria com a tabela vazia. | `tests/invariants/rls-isolation.test.ts` |
| **Sete verificações antes de cada envio, em ordem fixa e versionada.** Cada avaliação vira registro durável, exportável — inclusive as que barraram. | `lib/agent-engine/guardrails/before-send.ts` |
| **Atualizar não quebra.** O caminho de atualização é testado: o schema é aplicado em banco novo e reaplicado em banco existente, provando idempotência. | `scripts/test-db.sh` |
| **MIT, sem versão paga, sem funcionalidade travada.** O que você instala é o produto completo. | `LICENSE` |

> **CTA do bloco:** ⭐ Dar uma estrela no GitHub — *é o que ajuda outras pessoas a encontrarem o projeto.* `[116 estrelas]`

Pedido de star limpo, sem recompensa. Incentivar star com brinde viola a política do GitHub — e **90,42% dos repositórios com campanha de estrela falsa foram deletados**.

---

## 8. UM NÚCLEO, N NICHOS

> **Título:** O mesmo sistema atende quem vende consulta e quem vende tênis.
>
> **Corpo:** O vocabulário do funil é configurável: *lead* vira **Cliente**, **Paciente** ou **Comprador**; *ganho* vira **Pago**, **Agendado** ou **Fechado**. Não é tema, não é fork, não é "versão para clínicas" — é o mesmo núcleo, configurado.

Interativo leve: quatro abas (E-commerce · Clínica · Imobiliária · Serviços). Trocar a aba troca os rótulos no mesmo diagrama de funil. Uma imagem, quatro estados — **não** quatro imagens.

---

## 9. PARA QUEM INSTALA PARA CLIENTES

> **Título:** Instale para os seus clientes. Com a sua marca.
>
> **Corpo:** Duas variáveis no `.env` trocam nome e logo em toda a interface — sem tocar em código, porque código editado se perde na próxima atualização. Licença MIT: pode modificar, hospedar para terceiros e cobrar. Sem royalty.
>
> **Honestidade que vende:** cores e fontes ainda exigem alterar o design system, e a marca é por instalação, não por organização. Está tudo escrito no guia.
>
> **CTA:** Ler o guia para agências →

Imagem: a mesma tela em duas marcas diferentes, lado a lado.

---

## 10. INSTALAÇÃO

> **Título:** Um comando. Duas horas de configuração. Sem mensalidade nunca mais.

Bloco de código real, copiável:

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd SonghaiCRM/self-host-kit
bash install.sh
```

Três colunas de apoio:

- **2 GB de RAM bastam** — o servidor não compila nada, baixa uma imagem pronta.
- **HTTPS automático** — certificado emitido no primeiro acesso.
- **Travou? Tem assistente** — abra o Claude Code dentro da VPS e ele conduz por conversa, com nove armadilhas de ambiente já mapeadas.

> ⚠️ **Não prometemos tempo de instalação em lugar nenhum desta página.** O kit não declara isso e não medimos. O gargalo real é criar a conta do banco e o DNS propagar, não o script. Prometer "30 segundos" é a primeira promessa quebrada.

---

## 11. QUANTO CUSTA

> **Título:** O software é grátis. Você paga o servidor.
>
> **Corpo:** Não existe versão paga, não existe funcionalidade travada, não existe cobrança por usuário. Seu time cresce, sua conta não. O que você paga é a VPS onde ele roda e as chaves de IA que consumir.
>
> **Contraste, sem citar ninguém:** Plataforma fechada cobra por atendente. Cinco pessoas no comercial custam cinco vezes. Aqui, cinco ou cinquenta custam a mesma VPS.

Sem tabela de planos — não temos planos. Um bloco só, honesto.

---

## 12. FAQ CITÁVEL

Formato deliberado (é o que a pesquisa de GEO mediu como eficaz): **pergunta literal como H2 visível**, resposta direta nas duas primeiras frases, número verificável quando houver. Como HTML visível — não como JSON-LD escondido, que o Google descontinuou para FAQ.

1. Quanto custa o SonghaiCRM?
2. Preciso saber programar para instalar?
3. Qual VPS eu preciso?
4. Funciona com WhatsApp comum?
5. Serve para qual tipo de negócio?
6. Posso instalar para meus clientes e cobrar?
7. Como atualizo depois?
8. Meus dados ficam no Brasil?
9. O que acontece se a IA errar?
10. Preciso de cartão de crédito para testar?

A 9 é a mais importante e quase ninguém responde: *"Cada mensagem passa por sete verificações antes de sair, e todas ficam registradas — inclusive as que barraram um envio. Quando o agente não deve seguir sozinho, ele passa para um humano com resumo do que aconteceu."*

---

## 13. BANNER HOSTGATOR — ~~reconstruído~~ REMOVIDO (2026-08-21)

**Cancelado.** A parceria comercial com a HostGator terminou; não há mais banner de
parceiro nesta página. Conteúdo abaixo preservado só como registro da decisão anterior,
não implementar:

<details>
<summary>Plano original (obsoleto)</summary>

Reconstruído em HTML fluido (o original é 1680×600 fixo e quebra no celular), **mantendo os sinais visuais da HostGator** — laranja `#F67922`, navy `#073f60` — como um bloco de **parceiro claramente delimitado**. A ruptura de paleta vira intencional em vez de acidental: uma faixa de largura total, com respiro antes e depois, lida como "aqui começa outra coisa".

Removidos: **OpenClaw** e **Hermes** — não têm relação com o Deskcomm e diluem a conversão.

> **Eyebrow:** Parceiro oficial
> **Título:** Soberania com IA é na HostGator
> **Corpo:** Datacenter no Brasil, sem transferência internacional de dados. É onde o SonghaiCRM foi feito para rodar.
> **CTA:** Assinar a VPS com desconto da parceria →
> **Microcopy:** link de parceria — assinar por ele apoia o projeto

</details>

---

## FOOTER

Quatro colunas + barra inferior.

| Produto | Documentação | Comunidade | Projeto |
|---|---|---|---|
| Como funciona | Guia de instalação | GitHub Discussions | Licença MIT |
| Para agências | Guia para agências | Issues | Changelog |
| Preço | Arquitetura | YouTube | Segurança |
| FAQ | Doutrina do sistema vivo | Instagram | Contribuir |

Barra inferior: `SonghaiCRM · MIT · Feito no Brasil` · **`Página atualizada em [data]`** — visível, não só no schema: a pesquisa mediu que **75% das páginas citadas por IA foram atualizadas nos últimos 12 meses**, e a data de atualização discrimina melhor que a de publicação.

---

## Inventário de imagens

**11 imagens.** Todas 3D, geradas depois no ChatGPT a partir dos prompts da próxima seção.

| ID | Onde | O que mostra | Camadas |
|---|---|---|---|
| `mesa-01` | Hero | A mesa isométrica completa | 5 (tampo · trilhas · peças · rótulos · lead) |
| `viloes-01` | §2 | Mesa com peças desconectadas, um lead caindo pelo vão | 1 |
| `viloes-02` | §2 | Peça de robô falando sozinha, sem trilha de saída | 1 |
| `cena-01..07` | §4 | Sete estados da mesma cena em close | 4 cada, compartilhadas |
| `turno-01` | §5 | Vista explodida do turno do agente, 6 camadas | 7 (6 camadas + pulso) |
| `radar-01` | §6 | Radar com três anéis de risco | 3 |
| `nichos-01` | §8 | Funil neutro, rótulos como camada separada | 2 (base + 4 variantes de rótulo) |
| `marca-01` | §9 | Mesma tela em duas marcas | 1 |

**Total de arquivos:** ~28 PNGs (contando camadas). Em AVIF isso fica sob 1,2 MB no total, com só o hero em carregamento prioritário.

---

## Direção de arte para as imagens 3D

⚠️ **Este é o maior risco de qualidade da página inteira.** Onze imagens geradas em sessões diferentes viram onze estilos diferentes, e a página passa a parecer colagem. A defesa é um bloco de estilo fixo, colado **igual** em todo prompt, e gerar tudo na mesma sessão.

### Bloco de estilo (colar em todos os prompts)

```
Isometric 3D render, 30-degree camera angle, orthographic projection.
Matte clay material — soft, slightly rough, no gloss, no chrome, no glass, no neon.
Palette strictly limited to: warm off-white #faf9f6 background, surface #ffffff,
warm greige #e7e3da for structure, WhatsApp green #008069 for active
elements, muted amber #b8863b for warnings only. No other colors.
Soft studio lighting from upper left, long soft shadows in warm grey rgba(20,18,14,0.10).
No text, no labels, no UI chrome, no icons inside the render.
Generous empty space around the subject. Calm, precise, architectural.
Transparent background (PNG with alpha).
Style reference: architectural maquette, not videogame asset.
```

### Regras de camada

Cada camada é gerada como PNG separado **com alfa**, no mesmo enquadramento e escala. O jeito de conseguir isso: gerar a cena completa primeiro, depois pedir cada elemento isolado *"same scene, same camera, same lighting, only the [X], everything else fully transparent"*.

Rótulos **nunca** entram na imagem — são HTML por cima. Três motivos: texto em imagem não é lido por buscador nem por crawler de IA, não dá para traduzir, e fica serrilhado no retina.

### Prompt do hero (`mesa-01`)

```
[BLOCO DE ESTILO]

An isometric 3D scene of a single large rounded rectangular desk surface,
floating, seen from above at 30 degrees. On the desk sit five distinct low-profile
modules connected by thin recessed channels carved into the desk surface:
1. a rounded module suggesting a conversation thread (stacked soft plates)
2. a module of four vertical columns of small tiles (a pipeline)
3. a central rounded module, slightly taller, in WhatsApp green (the agent)
4. a small circular module with a subtle ring (follow-up timer)
5. a flat wide module of thin horizontal lines (the log)
The channels connecting them are recessed grooves, WhatsApp green at the bottom.
A single small WhatsApp-green sphere sits at the entrance of the conversation module.
Nothing is detached; every module touches at least two channels.
```

Depois, uma passada por camada: `tampo`, `trilhas`, `peças`, `lead`.

---

## O que eu preciso de você para executar

| # | Item | Por quê |
|---|---|---|
| 1 | **Aprovar a extensão de motion** (§0) | senão a LP viola a doutrina que o repo declara |
| 2 | **`deskcomm.com.br` apontado** | eu aviso quando a LP estiver pronta para deploy |
| 3 | **Gerar as 11 imagens** com os prompts | você faz no ChatGPT; eu entrego os prompts prontos, um por arquivo |
| 4 | **Confirmar o repo do site** | `deskcomm-site` público, separado do CRM (para clone não receber a LP) |

---

*Plano escrito em 27 de julho de 2026.*

---

## Apêndice — padrões de referência aprovados

Referências enviadas pelo Rafael em 27/07: **Google CodeWiki** e **Twenty CRM**. Aproveitamos o *mecanismo*; a paleta continua sendo a nossa.

### Do CodeWiki — o sólido que se abre nas próprias faces

Um cubo wireframe que, ao rolar, se desdobra nas faces que o compõem, cada uma carregando um ícone. É a melhor referência de motion que existe para a **§5 (turno do agente)**: um bloco fechado virando suas camadas.

**Adotamos:** a mecânica fechado → aberto, disparada uma vez, com as peças mantendo alinhamento no mesmo eixo.
**Rejeitamos:** fundo preto e o *glow* azul radial. Violam o anti-pattern nº 3 (`gradiente roxo/azul/rosa`) e nº 4 (`bg cool-gray`). Nosso equivalente de destaque é **ausência de sombra**, não luz emitida — coerente com material clay fosco.

### Do Twenty — trilho numerado + visual sticky

Título grande à esquerda, parágrafo curto embaixo, **trilho vertical numerado** (`01`, `02`, `03`) na margem esquerda marcando o passo atual, e o visual à direita evoluindo conforme o scroll.

**Adotamos integralmente na §4.** O trilho numerado resolve um problema real do scrollytelling: o visitante sempre sabe em que passo está e quantos faltam. Sem ele, sticky longo vira desorientação.

**Especificação do trilho:** linha vertical de 1px em `border`, com o segmento ativo em `accent` e o número em IBM Plex Mono. O número do passo atual fica em `text`, os demais em `text-muted`. Transição de 200ms só em `color` e `background`.

### Do Twenty — a textura de substrato

Paisagem isométrica de milhares de micro-retângulos, contraste baixíssimo, que lê como "a massa de dados por baixo". Dá densidade sem competir com o conteúdo.

**Adotamos** como fundo das seções técnicas (§5 e §7), em `#e7e3da` sobre `#faf9f6`, com opacidade ≤ 8% e `pointer-events: none`. Ver `textura-01-substrato` nos prompts.

**Cuidado:** essa textura é decoração pura — não explica nada. Por isso ela é **estática**. Movimentá-la seria exatamente o parallax decorativo que a §0 mantém proibido.
