# Pagamento confirmado sozinho e nota fiscal: o ponto é núcleo, o provedor é módulo

**02/out/2026.** Medido em `efed1d574`; **revisado em 14/out/2026 contra `ccbae41fd`**, porque a
cobrança do revendedor (ADR-0004) e a extração da comanda para módulo (0619) mudaram o que existe.
Continua sendo **pesquisa**: nada do desenho abaixo foi decidido nem construído. Este documento responde a um pedido da comunidade e serve de
**caso de prova** da [ADR-0005](../../adr/0005-plataforma-de-modulos-de-terceiro.md): se a plataforma
de módulos não resolver este caso, ela não serve.

> *"Eu implementaria também a API do banco central que confirma automaticamente pagamentos pix e
> também stripe, asaas… Até o nubank hoje em dia gera link de pagamento. Expedir notas fiscais."*
> — engenheiro de software, usuário do produto

O pedido está certo no destino e vale uma correção no caminho — e é justamente essa correção que
mostra por que isto é arquitetura de plataforma, e não uma integração.

---

## O que existe hoje (medido, não suposto)

**O caixa é núcleo** e já está construído: `financial_accounts`, `payment_methods` (nome da forma +
a conta em que o dinheiro cai), `financial_entries` (`direction`, `amount_cents`, `currency`,
`status in ('pending','paid')`, `paid_at`).

**A comanda não é mais núcleo.** Desde a 0619 (09/10), `sales`, `sale_items` e as demais tabelas da
comanda nascem só onde o módulo oficial `financeiro` é instalado (ADR-0002), e
`financial_entries.sale_id` fica sem FK onde ele não está:

```bash
head -1 supabase/migrations/20261009113329_0619_provisionadora_do_financeiro.sql
grep -n 'slug:' lib/modulos/catalogo.ts
```

**Já existe cobrança com confirmação automática — mas de outro eixo.** Desde 05–06/10 (ADR-0004, aceita em
29/09), o núcleo tem a **cobrança do revendedor**: o dono da instalação cobra as empresas que atende,
com checkout hospedado Stripe ou Asaas, Pix e boleto recorrentes pelo Asaas, um webhook assinado em
`/api/v1/webhooks/cobranca/[provedor]` e as tabelas `cobranca_planos` e `cobranca_assinaturas`. Ela é
capacidade com chave, desligada por padrão. **Não** serve à empresa cobrar o cliente final dela:

```bash
ls lib/cobranca/provedores/                 # contrato.ts, stripe.ts, asaas.ts
grep -oE 'create table (if not exists )?public\.(cobranc|charge|invoice|nota|documento_fiscal|recebiment)[a-z_]*' supabase/baseline.sql | grep -v 'cobranca_'
# vazio = nenhuma tabela de cobrança do cliente final nem de documento fiscal
```

O que **não** existe é a cobrança do **cliente final da empresa**: link de pagamento, confirmação
automática de que o cliente pagou, e documento fiscal. Para o caixa da empresa, uma forma de pagamento
chamada "Pix" é hoje só um rótulo: alguém olha o extrato do banco e marca o lançamento como pago à
mão. É exatamente o trabalho que o pedido quer eliminar.

---

## A correção de caminho: o Banco Central não confirma o seu Pix

O Banco Central publica o padrão da API Pix e opera a infraestrutura (SPI, e o DICT, que é o
diretório de chaves). O acesso a ela é de **instituição participante** — banco ou instituição de
pagamento autorizada. Um CRM não se credencia como participante, e não deveria querer: isso é
atividade regulada.

Quem confirma que um Pix caiu é **o PSP da conta que recebeu** — o banco ou o gateway do lojista.
Cada um expõe isso de um jeito: um banco grande costuma exigir certificado de cliente (mTLS) mais
OAuth e devolve um aviso de "Pix recebido" num webhook; um gateway como Asaas, Stripe ou Mercado Pago
resolve com chave de API e webhook assinado; e há PSP que só oferece link gerado na tela, sem API
nenhuma — nesse caso não existe confirmação automática a ser integrada, e o módulo precisa dizer isso
na cara do usuário em vez de fingir.

**Consequência arquitetural:** não existe "a integração de Pix". Existem N provedores, com N formatos
de credencial, N formatos de aviso e N vocabulários de estado. É a definição de um ponto de extensão —
e é o mesmo formato que o produto já resolveu **três** vezes: no canal de mensagem (`ChannelAdapter`),
no transporte de conversão de anúncio e — o mais próximo deste caso — no **contrato de provedor de
cobrança** do eixo 3 (`lib/cobranca/provedores/contrato.ts`, com Stripe e Asaas). Antes de desenhar um
contrato novo, vale avaliar reutilizar aquele: ele já tem `Situacao` relida na API, `SinalDoWebhook`
e `ErroDoProvedor` sem vazar corpo do provedor para log.

Se cada provedor virar código no núcleo, o Core engorda para sempre e cada cliente carrega o
integrador de um banco que não usa. Se cada provedor virar fork, voltamos ao problema que a plataforma
existe para acabar.

**Por que o eixo 3 ficou no núcleo e este iria para módulo.** A ADR-0004 aceitou manter dois
adaptadores de provedor **no núcleo** ("o preço de a cobrança sobreviver à atualização"). Isso não
contradiz o argumento acima, mas o restringe: lá são **dois** provedores, escolhidos pelo projeto, para
**um** usuário por instalação (o dono). Aqui o provedor é escolha de **cada empresa** — o banco ou
gateway em que ela já recebe —, com uma cauda longa de PSPs e de credenciais (inclusive mTLS). É a
cauda longa, e não o tema "pagamento", que empurra o provedor para módulo. *Inferência, não medição:*
se a demanda real se concentrar em dois ou três gateways, o argumento do eixo 3 volta a valer e o
caminho núcleo fica mais barato.

---

## O desenho

### 1. O núcleo ganha o RECEBIMENTO, que nenhum provedor possui

Uma tabela de núcleo — chame de `recebimentos` — com o ciclo de vida genérico e nada específico de
provedor. **Não** `cobrancas`: `cobranca` já é o nome do eixo 3 inteiro (o módulo-flag em
`MODULOS_OPCIONAIS`, as tabelas `cobranca_*`, `lib/cobranca/`, as rotas `/api/v1/cobranca/*` e o
webhook `/api/v1/webhooks/cobranca/[provedor]`), e dar o mesmo nome a outro eixo de dinheiro
confundiria os dois domínios. Este é **outro eixo**: a empresa cobrando o cliente final dela, fora da
tabela de eixos da ADR-0004 (D1).

- `organization_id`, e vínculo opcional a contato e lead (referenciar, nunca duplicar); o vínculo à
  comanda segue o padrão de `financial_entries.sale_id` — coluna sem FK onde o módulo `financeiro` não
  está instalado;
- `amount_cents` + `currency` (a régua de dinheiro do projeto), `due_at`, `description`;
- `status`: `rascunho` → `aguardando` → `paga` | `expirada` | `cancelada` | `estornada`;
- `provedor` (o slug do módulo que a atende) e `provedor_ref` (o id lá fora);
- `unique (organization_id, provedor, provedor_ref)` e o aviso do provedor com
  `unique (organization_id, external_id)` + captura de `23505` — o mesmo desenho de idempotência que
  a ingestão de WhatsApp já usa, porque webhook de PSP repete por projeto;
- o link e o QR quando o provedor os devolve.

**Quando o recebimento é pago, o núcleo faz o lançamento** em `financial_entries`, na conta apontada pela
forma de pagamento, dentro da mesma transação em que marca o recebimento. Essa é a razão de o
recebimento ser núcleo e não de módulo: dinheiro batendo no caixa é invariante do produto, e a ADR-0002 D9 já
recusou `jsonb` para domínio com dinheiro. Um módulo nunca escreve em `financial_entries`.

`payment_methods` ganha um vínculo opcional ao provedor. Assim "Pix Itaú" é uma forma de pagamento que
sabe qual módulo a executa e em que conta o dinheiro cai, sem duplicar nada.

### 2. O módulo implementa um provedor, e só isso

Contrato de adaptador, no molde do que já existe no canal de mensagem:

| Operação | O que o módulo faz |
|---|---|
| `criar_cobranca` | recebe valor, vencimento, pagador e devolve id, link e QR |
| `consultar` | reconcilia o estado quando o aviso se perde |
| `cancelar` | encerra a cobrança lá fora |
| `estornar` | quando o provedor suporta |
| `capacidades` | declarativo: pix, boleto, cartão, link, recorrência — e o host só oferece o que está declarado |

As capacidades são **dados**, como já são no canal: os gates do núcleo perguntam pela capacidade,
nunca pelo nome do provedor. Isso é o que impede o Core de ganhar um `if provedor === 'stripe'`.

O módulo **só pode confirmar a cobrança que ele mesmo criou**. A escrita entra por uma rota do host,
com o token do módulo, e o host confere o par (módulo, cobrança) antes de qualquer coisa — um módulo
de pagamento não pode marcar como paga a cobrança de outro provedor, nem de outra organização.

### 3. O aviso do provedor entra por uma rota do host, não do módulo — e só acorda a leitura

Uma rota de host com token por (instalação, organização), seguindo a regra que a ADR-0004 D4 já
aceitou para o eixo 3: **o aviso nunca é fonte de estado**. A rota confere a assinatura no corpo cru
(comparação de tempo constante), grava um ponteiro idempotente por `external_id`, responde rápido e
**acorda** a releitura; quem decide se o recebimento foi pago é a operação `consultar` do provedor,
relida na API dele. É o que `/api/v1/webhooks/cobranca/[provedor]` já faz:

```bash
sed -n '1,12p' 'app/api/v1/webhooks/cobranca/[provedor]/route.ts'
```

Arquivar o corpo cru para depuração continua útil, mas como diagnóstico, nunca como entrada da
decisão. O módulo recebe o evento já atribuído a uma organização — ele nunca escolhe de quem é o
pagamento.

### 4. A credencial fica na VPS do cliente, atrás de um proxy do host

Este é o ponto que decide se o caso funciona de verdade.

Um módulo `connected` roda no servidor do autor. Se ele precisasse da chave do banco do cliente, cada
cliente entregaria a credencial da própria conta bancária a um terceiro — inaceitável, e é o oposto do
motivo pelo qual alguém escolhe self-host.

A saída é o padrão de "segredo atrás do proxy", que Zendesk e Atlassian usam: o segredo é guardado
**cifrado no banco do cliente** (o produto já cifra credencial de canal com `fn_encrypt_oauth`), o
módulo declara os destinos que pode alcançar, e escreve `{{segredo.chave}}` no lugar do valor. **O
host faz a chamada**, injeta o segredo no momento do envio e nunca o devolve ao módulo — reaproveitando
a proteção contra SSRF e a régua de destino por organização que já existem no webhook de saída.

E uma peça nova, sem a qual o caso principal não existe: **o proxy precisa suportar certificado de
cliente (mTLS)**, porque é assim que a API Pix dos bancos grandes autentica. Sem isso, só gateway
funciona, e o pedido de "confirmar Pix direto no banco" fica de fora. Vale dizer na cara: é uma peça
nova do host, não do módulo.

### 5. Nota fiscal: o mesmo desenho, com uma recusa deliberada

`documentos_fiscais` no núcleo, com estados (`emitindo`, `autorizado`, `rejeitado`, `cancelado`),
chave, número, série, o que foi emitido, e PDF/XML no Storage com URL assinada. O emissor é módulo.

A recusa: **a primeira versão não guarda o certificado digital A1 da empresa do cliente.** Guardar
certificado de assinatura numa VPS de 4 GB sem módulo de segurança é assumir uma responsabilidade
desproporcional ao que o produto é hoje, e um vazamento ali não é "dado exposto", é documento fiscal
assinado em nome de outra empresa. O caminho da primeira versão é integrar com um emissor que já
guarda o certificado e já responde pela conformidade municipal e estadual — que é, de fato, como a
maioria dos sistemas resolve. Guardar o certificado localmente volta à mesa quando houver onde
guardá-lo.

Também vale escrever o que o produto **não** promete: nota fiscal de serviço é municipal, com padrão
nacional em adoção desigual, e nota de produto é estadual. Um módulo cobre os municípios que o emissor
dele cobre. Prometer "expedir notas fiscais" sem essa fronteira seria anunciar o que não existe — o
não-negociável 11.

---

## Por que este caso é a prova da plataforma

Ele exercita, de uma vez, tudo o que separa "módulo de verdade" de "pacote de JSON":

| O que o caso exige | Classe de módulo que precisa existir |
|---|---|
| tela de cobranças, lista e ficha | `data` (tela renderizada pelo host) |
| tabela própria do provedor (conciliação, taxas) | `data` (objetos declarados, compilados pelo host) |
| chamar o PSP e receber aviso | `connected` |
| credencial do banco e certificado | proxy de segredo do host, com mTLS |
| "enviar o link da cobrança no WhatsApp" | **rascunho sugerido**, nunca envio direto: o envio por token não passa pela cadeia anti-banimento |
| "cobrar o cliente que não pagou" | ação de automação do módulo + gatilho de cobrança vencida |
| o agente de IA informar se o cliente pagou | ferramenta de IA do módulo, de leitura, com o resultado tratado como dado e não como instrução |
| vender o módulo | cobrança pelo autor, organização como unidade (ADR-0005 D9, aceita em 14/10) |

E ele também mostra o limite: nada disso justifica deixar um módulo decidir dentro do turno do agente
ou dentro da cadeia de envio. Pagamento é caminho frio.

---

## O que falta decidir

1. **O recebimento entra como núcleo ou como módulo oficial com tabelas?** Recomendação: **núcleo**,
   pela mesma razão que o caixa é núcleo — dinheiro batendo no caixa é invariante do produto. O que é
   de provedor fica no módulo. (A comanda foi para módulo na 0619; o caixa não.)
2. **O proxy com mTLS entra junto com a onda 2 ou depois?** Recomendação: **junto**, senão o caso
   principal do pedido (Pix direto no banco) não é atendido e a plataforma se prova só com gateway.
3. **Qual provedor é o primeiro?** Recomendação: um gateway com webhook assinado e documentação aberta,
   para a prova de ponta a ponta ser barata; e um banco com mTLS logo em seguida, porque é ele que
   valida a peça nova.
4. **O projeto mantém um módulo de pagamento oficial, ou isso é da comunidade desde o início?**
   Recomendação: um oficial, de referência, que serve de exemplo vivo de autoria — e é o que permite
   cobrar da plataforma a mesma régua que se cobra de terceiro.

---

## Resposta ao autor do pedido

Em uma frase: **está no plano, e o pedido mudou o plano para melhor** — ele virou o caso que a
arquitetura de módulos tem de atender para ser aceita. A única correção é que não se integra "a API do
Banco Central": integra-se o PSP de cada cliente, e por isso a resposta certa é um ponto de extensão
com um módulo por provedor, em vez de um integrador de Pix dentro do Core.
