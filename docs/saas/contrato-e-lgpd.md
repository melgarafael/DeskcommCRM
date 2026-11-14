# Contrato e LGPD com o cliente final

Isto é um **roteiro para revisar com um advogado**, não um contrato pronto. Leve-o a quem
cuida do seu jurídico antes do primeiro cliente pagante.

## Quem é quem

A **empresa-cliente é a controladora** dos dados dos clientes dela: é ela quem decide para que
os dados servem. **Você é o operador**: guarda e processa os dados a pedido dela. Por isso o
relatório de LGPD do titular sai com a razão social e o encarregado (DPO) da empresa-cliente,
e **nunca** com a sua marca. A decisão está registrada no mapa de arquitetura da marca própria e
vigiada por teste.

## Para cada empresa-cliente

1. Entre como administrador da empresa: **Configurações › Sua empresa › Organização**.
2. Confira a **Razão social**: ela vai impressa no documento jurídico. Se ficou vazia na criação
   da empresa, nasceu igual ao nome fantasia.
3. Preencha o **DPO email** (o e-mail do encarregado pelos dados). Sem ele, o documento sai com
   o e-mail de DPO da instalação, que é o seu: o titular escreveria ao operador, e não à
   controladora.
4. Saiba onde ficam os dados: com o banco na própria VPS ([`coolify.md`](coolify.md)), eles
   ficam onde a VPS fica. VPS no Brasil deixa o CRM e o banco no Brasil.
5. Se a IA estiver ligada, avise o cliente **por escrito** que as conversas vão para um
   provedor de IA fora do Brasil.

## Cláusulas

| # | Cláusula | O que escrever |
|---|---|---|
| 1 | Objeto | Licença de uso do sistema, hospedado por você, com os módulos do plano contratado |
| 2 | Preço e vencimento | Valor, intervalo (mensal ou anual), forma de pagamento, reajuste |
| 3 | Teste grátis | Quantos dias e o que acontece no fim: sem pagamento, entra na régua como atraso |
| 4 | Atraso e suspensão | A régua do sistema: aviso no dia 0, aviso final 48 h antes, suspensão no dia da tolerância (padrão 7), volta ao pagar. Os dados ficam guardados durante a suspensão |
| 5 | Troca de plano | No teste grátis vale na hora; depois, vale a partir da próxima cobrança paga. Só entre planos do mesmo intervalo (mensal com mensal, anual com anual) |
| 6 | Cancelamento | O acesso vai até o fim do período já pago, sem reembolso proporcional |
| 7 | Papéis na LGPD | O cliente é controlador; você é operador e só trata dados conforme as instruções dele |
| 8 | Suboperadores | A empresa da VPS (onde ficam o CRM e o banco), o servidor de e-mail, os provedores de IA e o provedor de pagamento (Stripe ou Asaas) |
| 9 | Transferência internacional | Com a IA ligada, as conversas vão para os provedores ativos, com o país de cada um (regras em `lib/legal/operador.ts`) |
| 10 | Custo de IA | Chave do próprio cliente (BYOK) ou IA inclusa com teto mensal |
| 11 | Segurança e backup | Frequência do backup e onde a cópia fica guardada |
| 12 | Nota fiscal | Quem emite e quando (o sistema não emite) |
| 13 | Fim do contrato | Prazo para exportar os dados; depois, anonimização |
| 14 | Suporte | Canal, horário e prazo de resposta |

Na cláusula 9, liste os provedores de IA que você **de fato** usa: são os das chaves cadastradas
em Agente de IA › Credenciais de cada empresa e os das chaves de IA no `.env` da instalação. Uma
lista genérica copiada de outro contrato não descreve o seu tratamento.

As regras da lista estão codificadas em `clausulaDeTransferenciaInternacional`, em
`lib/legal/operador.ts`, que compõe a cláusula a partir do catálogo de provedores (campos `sede` e
`paisDeclarado` em `lib/ai/pontos/provedores.ts` e `lib/ai/pontos/provedores-de-servico.ts`) e do
que está ativo nesta instalação (`provedoresAtivosDaInstalacao` lê `ai_provider_credentials` —
ativa e validada — e as chaves de plataforma do `.env`). Enquanto nenhuma tela imprime a cláusula,
escreva-a à mão seguindo as mesmas regras:

- entram também os provedores que **não conversam** mas recebem dado da conversa: o Jev (a
  TypeSafe AI recebe cada mensagem) e o serviço de voz (recebe o áudio do cliente);
- provedor **sem credencial ativa** não entra: listar o que não é usado assusta sem informar;
- provedor que **declara a região de processamento** aparece com o país declarado, a fonte e a data
  da consulta — hoje só a DeepSeek (China, política da própria empresa, consultada em 12/11/2026);
- provedor que **só tem sede registrada** (Anthropic, OpenAI, OpenAI pela assinatura, Google,
  OpenRouter, TypeSafe) aparece com a **sede**, dito assim: a região de processamento dele deve ser
  conferida na política do provedor, e o contrato **não** afirma que ele declarou algo. A OpenAI
  declara região por projeto, o Gemini não publica a lista de países e o OpenRouter varia por
  chamada; não invente fonte nem data para nenhum deles;
- provedor **sem sede e sem declaração** (Requesty, ElevenLabs) aparece assim mesmo, com "não
  declara o país; consulte a política do provedor" — omitir esconde uma transferência que existe;
- endpoint próprio ou modelo local aparecem como **"no servidor do operador"**.

A data acompanha a **linha de quem declarou** (`fonteDoPais.consultadoEm`). A conferência das
**sedes** pelo catálogo tem data própria (`CONSULTA_DOS_PAISES_EM`), e é essa que o parágrafo cita
quando alguma linha fala de sede: ela diz quando ESTE catálogo conferiu as sedes, não que o
provedor tenha declarado onde processa. Ao mudar uma `sede` no catálogo, atualize a data no mesmo
commit. Exemplo de saída, com Anthropic e Google ativos:

> Com a IA ligada, o conteúdo das conversas é processado por: Anthropic (sede nos Estados Unidos —
> de quem recebe o conteúdo; não declara a região de processamento, consulte a política do
> provedor), Google (sede nos Estados Unidos — de quem recebe o conteúdo; não declara a região de
> processamento, consulte a política do provedor). A data acompanha a linha do provedor que declara
> a região de processamento; onde a linha diz sede, o país é o da empresa que recebe o conteúdo e a
> região de processamento deve ser conferida na política do provedor. As sedes foram conferidas no
> catálogo em 13/11/2026. O CRM e o banco ficam no servidor do operador, no Brasil. Você, como
> controlador, deve indicar na sua política o mecanismo de transferência que adota (Resolução
> CD/ANPD nº 19/2024).

## O argumento da ANPD, do jeito certo

A transferência internacional de dados é regulada pela Resolução CD/ANPD nº 19/2024. As
cláusulas-padrão contratuais são um dos mecanismos que ela prevê, e qual usar é decisão do seu
advogado. Com o CRM e o banco numa VPS no Brasil, o CRM e o banco ficam no Brasil. **A IA
transfere**: os provedores ficam fora do Brasil. Confira também os outros suboperadores da
cláusula 8 (e-mail, pagamento): se algum for de fora, ele também transfere.

Nunca diga "conforme com a LGPD" nem "servidor no Brasil = LGPD". Diga o que sai do país e onde
isso está no contrato.
