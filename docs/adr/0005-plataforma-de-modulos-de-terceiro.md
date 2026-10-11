# ADR-0005 — Plataforma de módulos de terceiro: o host compila, o terceiro declara, o código dele nunca entra no processo

- **Status:** proposta — espera o dono do produto nas cinco escolhas da seção *Decisões do dono*
- **Data:** 2026-10-02
- **Contexto medido em:** `efed1d574` (`main`) e nos 1.029 forks públicos do repositório
- **Lei que muda quando aceita:** [`docs/doctrine/extensoes.md`](../doctrine/extensoes.md) (não-negociáveis 2, 9 e 11), [ADR-0002](0002-tabelas-de-modulo-num-banco-so.md) (o marco 4 que a D9 deixou aberto) e [ADR-0003](0003-perfil-declarativo-v2-portas-nomeadas-e-vitrine.md) (D1 e D5)

---

## Contexto

### O pedido

Um membro da comunidade propôs o que o Perfex CRM tem: uma porta de entrada oficial para módulos, em
vez de um fork por nicho. Hoje quem precisa de dentista, barbeiro, imobiliária ou delivery copia o
repositório inteiro. O pedido é que o Core continue genérico e evolua no centro, enquanto módulos
independentes acrescentam telas, automações, integrações e dados — com a possibilidade de serem
vendidos.

O produto já tem algo chamado "extensões", e ele **não** é isso: é um pacote JSON de até 64 KiB que
contribui cards de orientação e botões para seis destinos fixos. Não executa, não guarda dado, não
tem tela própria. Confirme o vocabulário em vigor sem acreditar nesta linha:

```bash
grep -n 'EXTENSION_CAPABILITIES' -A10 lib/extensions/capacidades.ts
```

### A demanda, medida nos forks (não suposta)

A decisão de onde abrir ganchos não saiu de intuição. Foram listados os 1.029 forks; 362 receberam
push depois de criados, 360 puderam ser comparados com a `main`, e 130 estavam à frente. Dos 128 com
diff próprio (excluídos dois outliers: um app diferente e um despejo de 49 mil linhas num commit), o
resultado é:

| Régua | Número |
|---|---|
| Linhas do diff em **arquivos novos** | **76%** |
| Linhas em arquivos que já existiam | 24% (12,2% em `lib`/`api`/`workers`, 11,8% em UI) |
| Commits de produto que **modificam** comportamento do núcleo | 47,1% |
| …desses, o que de fato exige um **gancho de módulo** | **8 a 10%** dos commits de produto |
| Forks que criaram liga/desliga de módulo **por organização** | ≥ 7 |
| Forks que criaram cobrança/planos | ≥ 7 |

O resto dos 47,1% é conserto de bug genérico do Core (cerca de metade dos consertos — caminho de
contribuição, não de API), personalização de tela, ou retrabalho que o fork criou para si mesmo.

Duas consequências diretas:

1. **A plataforma deve cobrir primeiro a ADIÇÃO**, que é onde estão três quartos das linhas. Um
   sistema de ganchos no caminho quente do atendimento resolveria menos de um décimo da demanda e é
   a parte mais perigosa; ele vem depois, e com o contrato de ponto substituível que o Core já tem.
2. **A hipótese "o fork fica milhares de commits atrás por causa dos ganchos" não se sustenta.** A
   idade mediana do último sync dos forks à frente é de 16 dias, e a correlação entre fração de
   modificação e atraso é −0,06 (n=60). O custo real aparece como trabalho de merge (≥101 commits de
   sync ou renumeração de migration em 35 forks) e como retrabalho.

### O que já existe e vira o esqueleto

O caminho de módulo oficial da ADR-0002 **foi construído e tem consumidor real** (honorários). Ele já
traz o registro por instalação, a trava, o recibo idempotente, a proteção das tabelas e a conferência
que reprova alto. Veja na fonte:

```bash
grep -n 'fn_modulo_instalar\|fn_proteger_modulo_provisionado\|fn_conferir_modulos_instalados' supabase/baseline.sql
sed -n '1,30p' lib/modulos/catalogo.ts    # a vitrine; quem decide é a provisionadora no banco
```

O que falta para um terceiro não é o ciclo de vida — é que hoje o slug vem de um array TypeScript
compilado na imagem e o SQL do módulo é escrito à mão dentro do repositório.

### Os três fatos que fecham o espaço de soluções

1. **O processo do app carrega a role DONA do Postgres.** Nos três modos que o instalador monta
   sozinho, a `SUPABASE_DB_URL` que o app e o worker recebem é a role `postgres`. Medido no catálogo
   da imagem `supabase/postgres` (15 e 17): `rolbypassrls`, `rolcreaterole`, dona do schema `public`
   e das funções, com `net.http_post` e com poder de desligar triggers. Para o Supabase **na nuvem**,
   que é o padrão, isto é INFERIDO da mesma imagem e da mesma configuração de `supautils`, e vale
   medir antes de apoiar qualquer decisão só nisso — a conclusão abaixo não depende de os privilégios
   serem idênticos lá. O processo também tem as chaves de cifra e a service key. **Qualquer código de
   terceiro dentro desse processo herda o que o processo tem** — e nenhuma permissão de linguagem o
   contém. Confira a origem da credencial sem acreditar nesta linha:

   ```bash
   grep -n "SUPABASE_DB_URL=" hostgator-setup-kit/supabase-provision.sh
   grep -n "SUPABASE_DB_ADMIN_URL" docker-compose.prod.yml   # a admin é esvaziada: cerca a mais, não a que sustenta
   ```
2. **A imagem é única e nada constrói na VPS** (ADR-0001). O Next 16 App Router compila rotas e
   Server Components em tempo de build. Não existe drop-in de pasta como no Perfex, que é PHP
   interpretado.
3. **A VPS típica é 2 vCPU / 4 GB**, com os limites de memória de app + worker + WAHA somando 2.560
   MiB. Não cabem dezenas de contêineres de módulo.

---

## Decisões propostas

### D1 — Três classes de módulo, um contrato só

O campo `profile` do manifesto deixa de ter um valor único. As classes são cumulativas em poder e
crescentes em exigência de prova:

| Classe | O terceiro entrega | Onde roda | O que ganha |
|---|---|---|---|
| `declarative` (existe hoje) | JSON | nada executa | cards e botões para destinos fixos |
| **`data`** (onda 1) | JSON declarando objetos, campos, telas e ações de um catálogo | **nada do terceiro executa**; o host compila | tabelas reais, telas de lista/ficha, ações do host, eventos, ferramenta de IA |
| **`connected`** (onda 2) | JSON + **um serviço que ele mesmo hospeda** | servidor do autor | o de cima, mais integração externa, credencial própria, webhook do provedor, lógica própria |
| `hosted` (adiada) | JSON + artefato Wasm | runtime nosso na VPS | lógica local sem servidor do autor |

A classe `data` é a aposta principal, porque é ela que cobre os 76% aditivos **sem nenhuma peça viva
em produção**: sem servidor do autor, sem contêiner, sem egress, sem RAM, e com os dados dentro do
`pg_dump` do cliente.

### D2 — Código de terceiro nunca executa no processo do app nem do worker

Não é preferência de estilo; é a consequência do fato 1 do contexto. Decorre daí, por escrito: nada
de `node:vm`, `isolated-vm`, importar módulo npm do autor no build, Module Federation ou carregar
pasta de código. A fronteira de isolamento é **processo**: o servidor do autor (`connected`) ou um
runtime nosso sem segredo e sem rede (`hosted`).

### D3 — Os dados do módulo são DECLARADOS, e quem escreve o SQL é o host

O terceiro declara objetos e campos; o host **gera** o corpo da função provisionadora da ADR-0002 a
partir do artefato imutável já admitido, e a executa dentro da transação da instalação. O terceiro
nunca envia SQL, nome de tabela cru, nem DDL.

Regras que a geração cumpre, e que a ADR-0002 D4 exige para continuar valendo:

- **A provisionadora segue sem parâmetro.** O corpo é derivado do artefato; a função continua
  `security definer`, só de `service_role`, idempotente e sem seletor vindo de quem chama.
- **Nome por prefixo do publicador**, sem `__`, até 63 bytes (`NAMEDATALEN`), colunas reservadas
  proibidas, nome de policy por hash, e conferência de quem é dono da tabela antes de criar.
- **Tabela de módulo é server-only:** `revoke` de `authenticated` **antes** de chamar
  `fn_proteger_modulo_provisionado()`, para que toda mutação passe pela rota auditada do host em vez
  de pelo PostgREST.
- **Chave estrangeira só para uma allowlist de entidades do núcleo** (contato, lead, conversa,
  compromisso, usuário), com `on delete` declarado e **FK composta por organização** — a checagem de
  FK ignora RLS e aceitaria um id de outra organização.
- **`lock_timeout` na compilação**, porque uma FK para `contacts` toma `SHARE ROW EXCLUSIVE` com a
  ingestão no ar.
- **Cota em bytes, aplicada atomicamente na escrita.** O plano gratuito do Supabase tem 500 MB para
  todas as organizações daquela instalação.

**Por que não um armazém genérico `jsonb`:** a ADR-0002 D9 já recusou `jsonb` para domínio com
dinheiro, e o CLAUDE.md lista `jsonb` lock-in como anti-pattern. Um odontograma, um imóvel com
galeria e uma parcela de honorário precisam de índice, chave estrangeira, transação e invariante.
Declarar o schema e compilá-lo dá as duas coisas: nenhum SQL de terceiro e tabela de verdade.

### D4 — Autoridade efetiva é interseção, revalidada na transação do efeito

```
declarado no manifesto  ∩  consentido por AQUELA organização  ∩  papel de quem clica
```

Instalar não autoriza nada (não-negociável 3). A instância admite e instala o pacote; a organização
consente as concessões, em frases legíveis, e pode consentir menos do que o manifesto pede. Sem
usuário na origem (evento, cron), o teto é o papel `agent`. A revalidação acontece no banco, na mesma
transação do efeito — fora dela há janela entre a checagem e o uso, o que a bancada de 14/09 já
mediu.

Ator novo `module` em toda escrita, para a trilha de auditoria dizer qual módulo agiu.

### D5 — O módulo conectado PUXA o token; nada de segredo em trânsito numa fila

Na ativação por organização, o host registra um token ligado ao par (instalação, organização), com
hash no banco. O módulo o **busca** apresentando um HMAC do segredo da instalação; o token não viaja
dentro de uma mensagem de evento. Desativar ou remover revoga **na mesma transação**.

A identidade de quem está vendo a tela é um JWT curto assinado com o segredo daquela instalação,
usado para o módulo saber quem é — **nunca** para atribuir ao host uma ação pedida pelo módulo. Ação
é atribuída pelo token do módulo e pelo papel real.

### D6 — Nenhum módulo no caminho quente do atendimento, e isso é mecânico

Ingestão, dreno, turno do agente e cadeia de envio não chamam módulo. A guarda é uma varredura de AST
sobre esses arquivos, não uma frase de doutrina. Razão medida: a cadeia `before_send` roda **dentro
do lock por número de WhatsApp**, então cada milissegundo de terceiro serializaria todos os envios
daquele número.

`messages:send` fica **fora** da onda 1 e da onda 2, porque o caminho de token não atravessa a cadeia
`before_send` — um módulo que enviasse por ali furaria o ritmo anti-banimento pela lateral. O que o
módulo pode é **sugerir rascunho**.

Quando os ganchos de política entrarem (os 8–10%), eles usarão o contrato de ponto substituível que o
Core já tem para o Jev — teto de tempo, disjuntor por falhas, nunca lança, resultado discriminado, e
a regra de nunca aceitar só a resposta externa. Generalizar o que existe, não inventar outro.

### D7 — Tela: uma rota, um grupo, uma entrada genérica por registro fechado

Os registros internos do Core continuam **fechados e com teste de completude**. Cada um ganha **uma**
entrada genérica, estática, que despacha por dado (o que está instalado e consentido): uma rota
`/app/m/[modulo]`, um grupo "Módulos" na navegação, uma ferramenta de IA `module_tool`, uma ação de
automação `module_action`. Módulo é linha no banco, nunca código compilado na imagem.

Para a classe `data`, a tela é **renderizada pelo host** a partir da declaração — lista, ficha,
formulário, calendário, quadro e galeria — com os componentes do próprio produto. Isso preserva a
marca própria por construção.

Para a classe `connected`, a tela do autor entra em **iframe de origem separada e com `sandbox`**,
com contexto por `postMessage` de origem conferida. Servir o iframe pela origem do Core sem `CSP:
sandbox` e sem remover os cabeçalhos de sessão está **recusado** (ver abaixo): seria XSS armazenado e
fixação de sessão no mesmo domínio da sessão real. A renderização nativa a partir de um catálogo de
componentes (o padrão de Shopify, HubSpot e Twenty) entra se e quando o iframe se mostrar pobre para
o white-label.

### D8 — Distribuição: catálogo revisado, artefato pinado, atualização nunca automática

O artefato é pinado por `sha256`; o endereço do serviço de um módulo `connected` é pinado **no
catálogo revisado**, não no manifesto — manifesto não carrega URL (ADR-0003 D5). Nenhuma origem
desliga, pausa ou atualiza um módulo numa VPS (não-negociável 13): comunicado não é comando. O
operador tem um interruptor local que pausa todos os módulos.

### D9 — Comércio: o autor cobra, a organização é a unidade, e o host não vira intermediário

O catálogo revisado carrega rótulo de preço e o endereço de compra do autor. Para a classe
`connected`, a cobrança é do autor, no serviço dele, e um módulo que recusa por falta de pagamento
devolve um estado visível na tela — não um erro cru. Licença offline assinada, verificada pelo host,
só faz sentido quando existir a classe `hosted`; antes disso não há o que verificar localmente.

Verificação de licença **dentro** do módulo, no molde Envato/Perfex, é removível — é exatamente o que
produziu o mercado de módulos adulterados. Não a copiamos.

### D10 — Ponto de extensão de domínio nasce com consumidor real

Não existe inventário de ganchos hipotéticos (a régua "Ambos" da doutrina). Cada ponto novo entra com
contrato, consumidor e prova dos dois lados. Os três com demanda registrada hoje são **pagamento e
fiscal** (pedido da comunidade, detalhado em
[`docs/research/modulos/pagamentos-e-fiscal.md`](../research/modulos/pagamentos-e-fiscal.md)),
**prospecção** (#1758) e **agenda** (#1754). Em todos, o **ponto é núcleo e o provedor é módulo**.

---

## O que foi recusado, por escrito

| Recusado | Por quê | Reconsideraríamos se |
|---|---|---|
| **Contêiner de terceiro orquestrado pelo agente do host** | O agente roda como root no cron e hoje recebe do app um único booleano. Transformá-lo em "puxe e execute a imagem X" é a troca mais perigosa do desenho inteiro, e o endereço viria do banco | nunca nessa forma; a classe `hosted` usa runtime **nosso**, com a lista de módulos como dado, não a imagem |
| **Iframe do autor servido pela origem do Core**, por proxy, sem `CSP: sandbox` | XSS armazenado e fixação de sessão no domínio da sessão real | nunca |
| **Armazém `jsonb` genérico para dados de módulo** | ADR-0002 D9 e o anti-pattern de `jsonb` lock-in; nicho precisa de FK, índice e invariante | nunca para domínio com dinheiro |
| **SQL vindo do pacote** | o argumento D4 da ADR-0002 cai se o corpo da provisionadora vier de fora | nunca |
| **`messages:send` por token de módulo** | não atravessa a cadeia `before_send`, logo furaria o ritmo anti-banimento | quando o envio por token passar pela cadeia |
| **Endereço ou URL no manifesto** | ADR-0003 D5: o pacote nomeia, o host resolve; endereço vive no catálogo revisado | nunca |
| **JWT de contexto usado para atribuir ação** | atribuição tem de vir do token do módulo e do papel real, senão a tela vira autoridade | nunca |
| **Instrução de pacote no prompt do agente** | já recusado na ADR-0003: texto de terceiro ganharia autoridade de operador | nunca |
| **Executor Wasm na onda 1** | a bancada de 14/09 mediu só em macOS ARM64; falta Linux amd64, broker real e carga concorrente | depois dessa medição |
| **Telemetria de uso dos módulos** | DEC-004: só downloads e avaliações; identificador persistente é pseudônimo, não anonimato | com decisão própria antes |

---

## Ondas

| Onda | Entrega | Prova de aceite |
|---|---|---|
| **O0** | o conserto de `fn_extensions_finish_install`, sem o qual nenhuma entrada do catálogo oficial instala | feito: invariante vermelho antes, 39 verdes depois |
| **O1** | classe `data`: manifesto, compilador de objetos, telas renderizadas pelo host, instalar/atualizar/remover | **portar o módulo de honorários para um artefato declarado, sem nenhum PR no Core** |
| **O2** | classe `connected`: token puxado, consentimento, iframe com sandbox, eventos assinados, `module_tool`, `module_action` | um módulo de pagamento real, com receiver de verdade, provado em tela |
| **O3** | entregas de evento por cursor, disjuntor persistido, saúde do módulo na tela e aviso na Central | derrubar o módulo no e2e e ver o atendimento seguir inteiro |
| **O4** | vitrine, catálogo revisado por PR, rótulo de preço, SDK e guia de autoria | um terceiro de fora publicando sem ajuda nossa |
| **O5** | classe `hosted` | bancada em Linux amd64 e fixture hostil como critério |

A prova de aceite da O1 é deliberadamente dura: **portar um módulo que hoje existe como código no
repositório**. Um exemplo feito sob medida para a plataforma provaria menos.

---

## O que esta ADR precisa escrever antes de virar código

Estes pontos não são detalhe de implementação; cada um muda uma garantia e a spec da O1 os responde:

1. Uma varredura nova por **DDL em qualquer `security definer`** — a atual só alcança
   `fn_*_provisionar`, e o compilador cria uma função nova.
2. O **despacho da reaplicação** nas atualizações por coluna de origem do módulo, não por
   `to_regprocedure`, que não distingue oficial de terceiro.
3. **Se um módulo de terceiro suspenso reprova a atualização do núcleo.** Isto **não é hipótese**: o
   custo de reprovar já foi pago em produção, e com o módulo OFICIAL. Na v1.61.0, a conferência de
   isolamento do `update.sh` montava a lista esperada lendo o `baseline.sql` como TEXTO, e por isso
   cobrava as oito regras de honorários — que moram **dentro do corpo** da provisionadora e só
   existem depois de `fn_modulo_instalar`. Em **toda instalação sem o módulo** a atualização parou:
   site em 503, o run preso em `dispatched` com o agente do host repetindo a tentativa a cada 5
   minutos (desfazendo até a volta manual para a versão anterior), e o contêiner de manutenção de pé
   depois de a tela dizer que o sistema tinha voltado (issues #1897 e #1878, medido em instalação
   real em 28/09/2026).

   Consertado no PR #1906: a régua passa a cobrar **só policy cuja relação já existe no banco** —
   mais genérico que caçar `$f$` no texto —, com `tests/shell/regras-isolamento-sem-modulo.test.sh` de
   guarda, e com o cuidado de **não filtrar** quando a consulta ao banco vem vazia (surdo nunca).

   Duas consequências para esta ADR, e as duas são reforço, não dúvida: **(a)** a decisão fica
   escrita como "módulo de terceiro suspende, avisa e segue", porque o precedente mostra que derrubar
   a atualização por causa de um módulo custa instalação fora do ar com repetição automática; **(b)**
   o princípio que o #1906 estabeleceu — o kit confere o que existe no banco, não o que está escrito
   no arquivo — passa a ser **requisito da onda 1**: nenhuma peça de módulo pode entrar numa
   conferência que o kit faça por leitura do `baseline.sql`. O compilador multiplicaria esse defeito
   por módulo instalado.
4. **Reaplicação por hash do artefato**, para não alongar a janela de indisponibilidade quando nada
   mudou.
5. A reemissão da **cascata de LGPD** como última definição do apêndice do baseline, e o alcance da
   anonimização às tabelas do módulo por `to_regclass` (ADR-0002 D8), sem reescrever a função que já
   tem várias cópias no baseline — o caminho é o gatilho na transição de `is_anonimizado`.

---

## Decisões do dono

| # | Escolha | Recomendação |
|---|---|---|
| 1 | A classe `data` (host compila, nada do terceiro executa) é a onda 1, e `connected` vem depois? | **Sim.** Cobre 76% da demanda com zero RAM e zero peça viva; é também a de menor risco |
| 2 | Módulo de terceiro suspenso **não** reprova a atualização do núcleo (só avisa)? | **Sim.** O contrário deixa o cliente com app antigo sobre banco novo por causa de um módulo de fora |
| 3 | A unidade de cobrança é a **organização**, e quem cobra é o **autor** (o projeto não é intermediário na onda 2)? | **Sim** na onda 2. Intermediação com divisão de receita só com volume |
| 4 | O catálogo oficial aceita módulo com **dados**, revisado por PR, com selo? | **Sim**, com revisão proporcional: schema declarado é auditável por leitura |
| 5 | O endereço da vitrine pública (a escolha 5 do DEC-007 segue sem resposta) | define onde o catálogo é publicado; a onda 4 depende dela |

---

## Consequências

- **Quem instala:** continua com um banco só e nenhum passo novo. Instalar um módulo `data` cria as
  tabelas na hora; quem não instala não as carrega. Nenhum contêiner novo na onda 1.
- **Quem escreve um módulo:** escreve um arquivo declarativo e, na classe `connected`, um serviço
  HTTP na linguagem que quiser. Não precisa conhecer Next, nem o schema do Core, nem rodar a VPS.
- **O Core:** ganha uma entrada genérica por registro fechado, e os registros continuam fechados.
  Nenhuma tela do núcleo passa a depender de módulo (não-negociável 1).
- **A doutrina:** o não-negociável 2 é emendado **só** para dados declarados e para as portas novas
  de tela; o não-negociável 11 continua valendo, e nada é anunciado antes da prova.
