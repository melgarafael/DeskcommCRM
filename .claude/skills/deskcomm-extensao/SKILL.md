---
name: deskcomm-extensao
description: 'Guia para criar uma extensão do DeskcommCRM — o pacote declarativo — em vez de abrir um PR no núcleo. Use SEMPRE que alguém quiser criar extensão, plugin, módulo, tema ou integração de nicho (comanda, comissão, fidelidade, roteiro de clínica, campo só para o meu caso), perguntar "isto é núcleo ou extensão?", "como publico no catálogo?", "dá para adicionar uma tela para o meu segmento?", ou quando a triagem mandar transformar um PR de nicho em extensão. Traz a régua de destino, o contrato do pacote campo a campo com exemplo válido, o que uma extensão NÃO consegue fazer hoje (sem código, tabela, tela, menu ou ferramenta de IA) e o envio por pull request com revisão humana.'
metadata:
  publico: contribuidor de nicho, agência, criador de pacote
  lei: docs/doctrine/extensoes.md
---

# Criar uma extensão do DeskcommCRM

Alguém chega com uma ideia de nicho — comanda de barbearia, comissão de vendedor, um roteiro de
pós-atendimento de clínica — e o instinto é abrir um PR no núcleo, acrescentando um campo, uma
aba, uma regra. O núcleo precisa continuar útil com **zero** extensões: é isso que mantém o
produto genérico enquanto os nichos ganham espaço. Este guia é para onde a triagem manda quem
chegou por ali, e para quem já sabe que quer criar um pacote.

A lei é [`docs/doctrine/extensoes.md`](../../../docs/doctrine/extensoes.md). O contrato em vigor é
`lib/extensions/manifest.ts` e `lib/extensions/capacidades.ts`. Quando este guia e o código
discordarem, o código está certo — e todo número aqui vem com o comando que o revela.

## Como você age

- **Primeiro classifica, depois ensina.** Metade do que chega como "extensão" é núcleo, e a outra
  metade é uma jornada que o formato atual ainda não constrói. Mandar alguém escrever um pacote
  que não pode existir custa mais que uma resposta desconfortável.
- **Não anuncia o que não existe.** Não há SDK, execução de código de terceiro, marketplace
  público, avaliação nem contador de downloads. A lei proíbe prometer os quatro antes da prova
  (não-negociável 11), e prometer a alguém que vai investir uma semana é a pior forma de prometer.
- **Mede na fonte.** Limite, vocabulário e versão do host saem de `lib/extensions/`, nunca de
  memória.
- **Preserva o trabalho de quem chegou.** "Isto não cabe hoje" vem sempre com o que fazer com o que
  já foi feito.

## Passo 1 — isto é núcleo ou extensão?

A pergunta que decide, e ela não é "isto serve a muita gente?":

> **Se nenhuma organização desta instalação ativar isto, a operação comum continua inteira?**

**Sim** → pode ser extensão. **Não**, porque identidade, autorização, isolamento, auditoria,
contratos ou a cadeia de envio dependem disto → é núcleo.

| Núcleo | Extensão |
|---|---|
| contatos, conversas, funis, agenda | comanda, comissão, fidelidade |
| papéis, permissão, isolamento entre organizações | tema visual, roteiro de um método de vendas |
| auditoria, recibos, cadeia de envio, opt-out | integração com um ERP de um segmento só |
| caixa: contas, formas de pagamento, plano de contas, lançamento avulso (**decisão do dono**, não dedução) | o que fica **em cima** do caixa |
| corrigir comportamento que já foi distribuído | jornada adicional que ninguém precisa ligar |

Os dois lados com mais exemplos, o destino "ambos" e o que fazer quando a régua diz extensão mas a
ferramenta ainda não existe: [`references/decidir-nucleo-ou-extensao.md`](references/decidir-nucleo-ou-extensao.md).

## Passo 2 — o que uma extensão consegue fazer hoje

Esta lista vale para o perfil `declarative`. O host admite também `data` e `connected` (módulo
conectado, F1): o `connected` não publica cards e não leva endereço no pacote, porque o endereço do
serviço fica na entrada do catálogo. Lista atual dos perfis: `grep -n 'profile: z.enum' lib/extensions/manifest.ts`.

**O que ela faz:** publica até 4 **cards de orientação** no hub do CRM. Cada card tem título,
descrição, blocos de texto e **um botão**, e esse botão abre uma tela que o CRM já tem. Quem
administra a instalação admite o catálogo e instala; quem administra a organização ativa e
configura (densidade e mostrar descrição); quem usa lê e clica, dentro do acesso que já tinha.
As telas alcançáveis são seis: Tarefas, Conversas, Funil, Contatos, Agenda e Radar.

**O que ela não faz — e nenhuma dessas é "ainda não implementei":**

| Não existe | Por quê |
|---|---|
| **Código.** O pacote é JSON. Sem JavaScript, SQL, shell, expressão | não há executor isolado; a escolha dele é por evidência, e ainda não foi feita |
| **Tabela ou qualquer dado próprio** (`data` só aceita `{"mode":"none"}`) | módulo nativo com tabelas é a ADR-0002, **aceita em 17/09/2026 e não construída** |
| **Tela, rota ou item de menu** | mesma ADR-0002 |
| **Ferramenta, instrução ou prompt do agente de IA** | recusado por escrito na ADR-0003: o motor de instruções caminha pelo conteúdo da sessão, e deixar o pacote escolher o caminho é leitura do que não é dele |
| **Endereço livre** (`href`, prefixo, destino próprio) | alcançaria as telas onde a instalação guarda segredo com todos os testes verdes. Recusado **para sempre** |
| **Imagem, captura de tela, URL** de qualquer tipo | endereço clicável dentro de pacote de terceiro é porta de engano; o ícone sai de uma lista de três |
| **Ler dado do CRM** — tarefa, conversa, contato | a capacidade abre uma porta que o núcleo já tem, com a autorização de sempre; ela não concede leitura |
| **Depender de outra extensão** | `dependencies` é `[]` |
| **Marketplace, avaliação, download contado, telemetria** | não existem, e a lei proíbe anunciá-los antes da prova |

Se a sua ideia precisa de uma linha desta tabela, **pare aqui** e vá para o Passo 6.

## Passo 3 — escreva o pacote

Comece pelo exemplo válido: [`references/pacote-de-exemplo.json`](references/pacote-de-exemplo.json)
— um roteiro de clínica com dois cards, que usa **duas** portas (Conversas e Agenda). Copie, troque
os textos e os slugs, valide.

O esqueleto, com o que cada campo cobra:

```json
{
  "format_version": 1, "profile": "declarative",
  "publisher": "slug-minusculo", "name": "slug-minusculo", "version": "1.0.0", "license": "MIT",
  "host_api": { "min": 2, "max": 2 },
  "permissions": ["navigation.inbox", "navigation.agenda"],
  "dependencies": [], "data": { "mode": "none" },
  "display": { "title": {…}, "summary": {…}, "category": "service", "icon": "ListChecks" },
  "configuration": { "density": "comfortable", "show_description": true },
  "contributions": { "crm_cards": [ { "id": "…", "action": { "capability": "inbox.open" } } ] }
}
```

As três regras que mais recusam pacote:

1. **Chave desconhecida recusa o pacote inteiro.** Autoria, site, etiqueta e imagem **não** moram
   no manifesto — são metadado de catálogo, o artefato que passa por revisão (ADR-0003, D3).
2. **Toda capacidade usada tem de estar coberta por uma permissão declarada.** Usar `inbox.open`
   sem declarar `navigation.inbox` é recusado na instalação, na ativação e na leitura: a lista de
   permissões é o que a tela mostra **antes** de alguém aceitar a extensão.
3. **`host_api` é a janela que você garante.** Um pacote que usa as portas novas declara `min` 2.
   Confira o host: `grep -n "HOST_API_VERSION =" lib/extensions/manifest.ts`.

Campo a campo, com os limites e o formato do texto localizado:
[`references/contrato-do-pacote.md`](references/contrato-do-pacote.md). O exemplo explicado, com o
que é decisão sua e o que é obrigação: [`references/exemplo-comentado.md`](references/exemplo-comentado.md).
Quando o parser recusar e não disser por quê: [`references/erros-do-pacote.md`](references/erros-do-pacote.md).

## Passo 4 — valide antes de enviar

```bash
bash .agents/skills/deskcomm-extensao/scripts/validar-pacote.sh caminho/do/pacote.json
```

Roda `parseManifest()` e `checkCompatibility()` **do host** — não uma cópia das regras — e, quando
passa, imprime a entrada de catálogo com `sha256` e `byte_length` calculados dos seus bytes. Sai 1
quando recusa.

Passar aqui é o piso: o schema não julga se o card vale uma instalação. Os degraus seguintes — o
catálogo de ensaio local e a prova pela tela — estão em
[`references/testar-local.md`](references/testar-local.md), com a ressalva medida sobre o
laboratório, que carrega a própria cópia das regras e pode estar atrás do contrato.

## Passo 5 — envie

Por **pull request**, com revisão humana. Merge não publica: validação automática e revisão
proporcional ao perfil **antecedem** a publicação, e teste verde não é selo.

No corpo do PR: o que a extensão faz em duas frases, para qual nicho, quais portas abre e por quê,
a saída do validador (o comando e o resultado, não a conclusão), o destino declarado — "extensão",
com a razão medida pela pergunta-raiz, que é o item 18 do Definition of Done — e o que você **não**
mediu. A mecânica de PR deste repositório (branch, identidade, fragmento em `.changes/`) está na
skill `deskcomm-contribuir`; carregue-a antes de abrir.

O que a revisão olha, em ordem, e o que acontece depois de publicado (nenhuma origem desliga uma
extensão numa VPS em silêncio): [`references/enviar-e-revisao.md`](references/enviar-e-revisao.md).

**Usar na sua própria instalação não pede permissão de ninguém** — pacote seu, catálogo seu,
admitido pela tela. O PR é só para entrar no catálogo oficial.

## Passo 6 — o meu caso não cabe no formato

Acontece com a maioria das boas ideias, e a resposta honesta vale mais que um encaminhamento
simpático. Na ordem:

1. **Precisa guardar dado, ter tela própria ou entrar no menu?** O caminho é o módulo nativo da
   [ADR-0002](../../../docs/adr/0002-tabelas-de-modulo-num-banco-so.md) — tabelas criadas por uma
   função provisionadora quando o módulo é instalado na instância. Ela foi **aceita em 17/09/2026 e
   ainda não foi construída**. Não há data, e este guia não inventa uma.
2. **Parte do seu trabalho é genérica e o núcleo já usa hoje?** Essa parte entra pelo caminho normal
   de PR, separada do resto.
3. **O que sobra é conteúdo** — orientação, roteiro, sequência de passos? Isso **é** empacotável
   hoje. Volte ao Passo 3.
4. **Nada disso?** Abra uma issue descrevendo a jornada inteira e o que ela precisa guardar. A
   doutrina é explícita: enquanto a plataforma está em construção, "extensão" é destino, não
   exigência de usar uma ferramenta que ainda não existe — o trabalho se preserva e a dependência
   se registra.

## O que você nunca faz

- Prometer SDK, execução de código, marketplace público, avaliações ou downloads — nem "em breve".
- Inventar um caminho de pasta para o pacote no repositório: onde a loja mora ainda não está
  decidido (ADR-0003, "o que esta ADR não decide").
- Sugerir que o contribuidor amplie o perfil declarativo por dentro para caber o caso dele. Quem
  propõe um item da coluna "ainda não existe" segue a coluna "o que pede antes", que é prova.
- Recomendar que alguém extraia do núcleo um recurso já distribuído porque "seria extensão": isso
  exige equivalência demonstrada e migração explícita.
- Aceitar `publisher` que se parece com marca alheia, ou texto que descreve uma extensão que o
  pacote não é.
