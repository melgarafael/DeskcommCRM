Refs #3900

## O defeito, medido

Numa agência de viagens a equipe viaja pela própria agência: o WhatsApp pessoal de cada atendente é **também** um contato do CRM. No modo `responsavel` o aviso de caso já sai para esse número, mas a rota recebia `aviso_numero_de_cliente` — porque o número de aviso vira **interno**. Quem confirmava com `confirma_contato: true` gravava o número em `telefone_destino`, e a partir daí **tudo** o que chegava dele era cortado na ingestão (`lib/escalacao/numero-interno-de-aviso.ts`): quando a atendente viajava e escrevia como cliente, a mensagem não virava contato, conversa nem atendimento.

Medição do passo 0:

| pergunta | resposta |
| --- | --- |
| onde o destino é classificado como cliente | guarda de `numero_de_cliente` dentro de `public.fn_definir_aviso_de_caso` (última definição em `20261103130100_9094_aviso_por_modelo_aprovado.sql`): compara `regexp_replace(contacts.phone_number, '\D', '', 'g')` com as variantes do destino e levanta `22023 aviso_de_caso_numero_de_cliente` |
| como o sistema sabe que um número é de um membro da equipe | `public.user_organizations.whatsapp_e164` — a coluna que a 9078 já grava por `p_responsaveis` e que a própria `fn_definir_aviso_de_caso` **já usa** para resolver o destino em `responsavel` |
| precisa de coluna nova? | **não** — o vínculo número↔membro existe desde a 9078 |

## O desenho

Quando o destino é o WhatsApp de um membro **ativo** (`revoked_at is null`) da equipe **e** o modo é `responsavel`, o aviso sai **sem** marcar o número como interno. Não é um `confirma_contato` automático na rota: quem decide continua sendo o banco, na mesma transação da escrita, e a função passa a **responder** `destino_e_de_membro` para a rota carimbar na auditoria.

A exceção é estreita de propósito:

- **só `responsavel`** — em `fixo` o destino é o número da empresa, ele vira interno de verdade e a pergunta continua sendo feita (comportamento igual ao de hoje para quem nunca escolheu o modo novo);
- **só membro ativo** — cliente comum continua recebendo `aviso_numero_de_cliente`, e `confirma_contato` continua obrigatório para ele;
- **só entrada sem comando** — na ingestão, `RESPONDER`/`PERGUNTAR` do número de destino continuam sendo resposta de caso, e o **eco do próprio envio** continua cortado (senão cada aviso criaria uma conversa consigo mesmo);
- o **primeiro salvamento** funciona: a guarda também olha `p_responsaveis`, porque na primeira gravação `whatsapp_e164` ainda é nulo (a guarda roda antes do laço que escreve a coluna);
- casamento pelo nono dígito, via `phoneLookupVariants`/`regexp_replace`, como o resto do arquivo.

### Registro de qual regra autorizou

`api_audit_log` é append-only, então o carimbo tem de ser explícito: `app/api/v1/ai/cases/alerta/route.ts` grava `autorizacao_do_destino: "membro_da_equipe" | "confirmacao_explicita" | "sem_confirmacao"`. Sem isso, "a pessoa confirmou" e "o número é da equipe" ficariam indistinguíveis, e a próxima pessoa não consegue responder por que uma atendente continuou chegando ao CRM.

### Tela

`app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx` passa a dizer, no bloco da equipe, que a pessoa pode ser cliente da própria empresa e que nesse caso o número **continua** entrando no CRM — diferente de um número interno. Texto novo em `t()`, com as três traduções (`dicionario.ts` + `en.json` + `tr.json`), sem chave duplicada.

### O que NÃO mudou

- nenhuma coluna, nenhuma tabela: `create or replace` da **mesma** assinatura de 10 parâmetros;
- o aviso da **agenda** (`fn_definir_aviso_de_agendamento`) não foi tocado — o destino dele não vem de membro;
- nada no caminho que faz um número virar interno: a exceção só **evita acioná-lo**;
- `supabase/baseline.sql` recebeu o apêndice com o corpo idêntico, antes da VARREDURA anon; a migration declara `-- manifest:` e não acrescenta linha no MANIFEST.

## RED / GREEN

**RED literal** — o mesmo arquivo de invariante rodado no `origin/main` (`da677c4e5d`), sem a correção:

```
❯ tests/invariants/aviso-para-membro-da-equipe.test.ts (7 tests | 5 failed)
  × RED do defeito: o destino é contato, é membro, e o aviso PASSA sem confirmação
  × o número NÃO vira interno: a gravação convive com o contato de mesmo telefone
  × a OUTRA grafia do nono dígito também é reconhecida como o membro
  × primeiro salvamento: o número ainda está em `p_responsaveis`, não na coluna
psql: ERROR:  aviso_de_caso_numero_de_cliente
```

No unitário, o mesmo no base: 9 casos falham (`destinoDoAvisoEhDeMembroDaEquipe` não existe e a mensagem do número do membro é consumida).

**GREEN** — neste branch:

- `tests/unit/aviso-de-caso-membro-da-equipe.test.ts` — **18/18**: regra pura (incluindo a outra grafia do nono dígito), leitura por organização, cinto de segurança, e o corte da ingestão — mensagem comum do número do membro **não é consumida** (é isto que a deixa virar contato e conversa), `RESPONDER` continua consumido, o eco de saída continua cortado, cliente comum continua cortado;
- `tests/invariants/aviso-para-membro-da-equipe.test.ts` — **7/7** via `pnpm test:db` (baseline install + update idempotente verdes): membro que também é cliente passa sem confirmação e a função responde `destino_e_de_membro`; cliente comum continua recusando; `fixo` continua recusando; membro revogado não abre exceção; primeiro salvamento reconhece o número vindo em `p_responsaveis`.

## O que não foi medido

- não há teste ponta-a-ponta de webhook: a prova de que a mensagem **entra** é o `consumed: false` do corte (o ingestor segue para o upsert de contato/conversa) mais o invariante de que o número continua sendo um contato — não subi um WAHA/Meta falso para ver a linha nascer em `messages`;
- a rota não tem teste novo próprio: a auditoria é uma chave a mais no metadata, e o `destino_e_de_membro` que a alimenta está provado no invariante do banco.
