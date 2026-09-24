# Trackeamento de campanha, conjunto, anúncio e posicionamento

Quem opera tráfego pergunta "de onde veio este lead?" em quatro níveis — campanha, conjunto, anúncio e posicionamento — e a ficha do contato responde nos quatro, quando a origem atravessa até o CRM.

Este documento descreve o desenho inteiro: as três fontes de tráfego que chegam ao WhatsApp, o que cada uma precisa, e como configurar.

## As três fontes, e o que cada uma precisa

| Fonte | Como a origem chega | O que o operador faz |
|-------|---------------------|----------------------|
| **Campanha de conversão para WhatsApp** | `referral` nativo no webhook (`ctwa_clid`, `source_id`) | nada — é automático |
| **Formulário na página** | POST direto ao webhook; `lib/webhooks/inbound.ts` aceita qualquer chave `utm_*` | põe as UTMs nos campos do formulário |
| **Página com botão de WhatsApp** | só o TEXTO da mensagem atravessa | escolhe um dos dois transportes abaixo |

**Por que a terceira fonte é diferente, e a razão é física.** O link `wa.me` não fala com o CRM: ele abre o aplicativo no aparelho da pessoa, e o servidor nunca vê aquele clique. A única coisa que chega depois é o texto da mensagem — por isso a origem tem de viajar dentro dele.

Os dois modos ingênuos não funcionam, e isso é medido, não suposto: `wa.me?utm_campaign=x` não chega (só o `text` viaja pelo sistema operacional, sem cookie nem referrer), e UTM escrita em texto solto é ignorada de propósito — o texto é do cliente, e aceitá-lo faria qualquer pessoa forjar atribuição.

## Os dois transportes do texto

Ambos funcionam, nenhum está depreciado, e a diferença é quem monta o marcador.

### `[ref:XXXXXX]` — o endereço de captura (recomendado)

O botão da página aponta para um endereço do próprio CRM em vez do `wa.me`. O servidor guarda as UTMs, gera um código de seis caracteres e redireciona para o WhatsApp com esse código no texto:

```
Olá! Vim pelo site. [ref:K7M2P9]
```

Onze caracteres na mensagem, e **nenhum script na página**. É o mesmo mecanismo que o produto já usa para capturar o `gclid` do Google Ads.

### `[dk1:<base64url>]` — o código auto-contido

A página monta o marcador com as UTMs dentro dele, em base64url. Não precisa de servidor no meio, e por isso continua sendo a saída para quem não pode mudar o destino do botão — ao custo de cerca de 200 caracteres visíveis na mensagem do lead e de um script na página, porque o marcador tem de ser gerado **por visitante**: dois visitantes vindos de campanhas diferentes não podem sair com o mesmo marcador, e link estático não gera nada.

O contrato está em `lib/leads/origem-do-site.ts`.

## Por que o ref precisa passar pelo servidor

A pergunta natural é "por que não deixar o código pronto dentro do link".

```
João  clica (Black Friday)  → precisa de um código, ligado a Black Friday
Maria clica (Dia das Mães)  → precisa de OUTRO código, ligado a Dia das Mães
```

Um link é texto parado: entrega o mesmo valor a todo mundo. Para o código nascer no clique, alguma coisa tem de executar naquele instante — ou um script na página (o `[dk1:]`) ou um redirecionamento pelo servidor (o `[ref:]`).

O que NÃO precisa nascer por visitante são as UTMs: elas podem estar fixas na URL colada, quando cada campanha tem sua página ou seu botão.

## Como configurar o endereço de captura

1. Em **Configurações → Conversões**, seção "Quem chegou pelo site", escolha o número de WhatsApp e o texto que a pessoa vai enviar. O texto precisa manter o campo do código.
2. Copie o endereço que a tela mostra.
3. Cole no botão de WhatsApp da sua página, no lugar do link `wa.me`.
4. No anúncio, ponha as macros de URL nos parâmetros: `utm_campaign`, `utm_adset`, `utm_ad` e `utm_placement`.

**Se a mesma página serve mais de uma campanha**, o botão precisa repassar os parâmetros que a página recebeu. Um `href` fixo não carrega UTM nenhuma: a conversa entra, e sem origem. A alternativa é o anúncio apontar direto para o endereço de captura, sem página no meio.

## O que a ficha do contato mostra

Primeiro que existir vence, da esquerda para a direita:

| Linha na tela   | Chaves lidas, em ordem                      |
|-----------------|---------------------------------------------|
| Origem          | `utm_source` → `ad_platform` → `source`     |
| Campanha        | `utm_campaign` → `campaign_name`            |
| Conjunto        | `utm_adset` → `adset_name`                  |
| Anúncio         | `utm_ad` → `ad_name` → `ad_title`           |
| Posicionamento  | `utm_placement`                             |

Linha sem valor não aparece: um travessão em cinco linhas seguidas lê como defeito de cadastro, não como "este contato não veio de anúncio".

## Limites declarados

- **A origem vale só na PRIMEIRA mensagem do contato, e não sobrescreve o primeiro toque.** Testar com um número que já é contato antigo não estampa nada — parece defeito, é a regra funcionando. Quem chegou de anúncio pago primeiro mantém o anúncio pago; quem chegou do site primeiro mantém o site.
- **Um ref só é consumido uma vez.** O mesmo texto encaminhado adiante não vira atribuição de quem o recebeu.
- **Posicionamento não existe no clique-para-WhatsApp.** A plataforma expõe *placement* só em breakdown de insights agregado, nunca por clique individual.
- **Falha de captura nunca vira tela de erro.** Todo caminho ruim do endereço de captura devolve o WhatsApp — sem o código, se for o caso. Clique de anúncio é dinheiro gasto: perder a atribuição é aceitável, perder o lead não.
- **O texto do cliente é entrada não confiável.** A lista de chaves aceitas é fechada (`CHAVES_DE_UTM`), com teto por valor; o que não é chave de campanha não atravessa, por construção.

## Onde isto mora no código

| Peça | Arquivo |
|------|---------|
| Contrato `[dk1:]` e a lista de chaves | `lib/leads/origem-do-site.ts` |
| Mecanismo do código curto (gerador, padrão) | `lib/plataformas-de-anuncio/captura-de-clique.ts` |
| Par ref↔UTM (consumo) | `lib/plataformas-de-anuncio/meta/captura-de-clique.ts` |
| Par token↔gclid (Google Ads) | `lib/plataformas-de-anuncio/google/captura-de-clique.ts` |
| Endereço de captura de UTM | `app/api/v1/anuncios/meta/[org]/route.ts` |
| Endereço de captura de gclid | `app/api/v1/anuncios/google/[org]/route.ts` |
| Consumo na ingestão | `lib/channels/pos-entrada.ts` (`guardarOrigemDaPagina`) |
| Tela | `app/app/settings/conversoes/` |
