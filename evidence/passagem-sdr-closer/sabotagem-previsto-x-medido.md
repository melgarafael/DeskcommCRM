# Sabotagem — #3514 (previsto ANTES de rodar)

Réguas que a entrega promete, e a sabotagem que prova cada uma. Cada perna é
sabotada nos dois lados que ela tem: o BANCO (a porta) e a AÇÃO (o uso da porta).

Arquivos: `lib/automation/actions/assign-owner.ts` e `supabase/baseline.sql`.
Restauração por cópia do `.bak` + `sha256` conferido a cada sabotagem.

## Perna 1 — a carteira do contato

### S1 · banco: a função volta a recusar ator nulo (a janela da 0799 não existe)
`supabase/baseline.sql`: o bloco `if v_ator is null then ... if v_origem <> 'automacao'`
volta a ser `if v_ator is null then raise exception 'carteira_sem_ator'`.

**Previsão:** o invariante reprova em UM caso — "sem ator e com a origem `automacao`,
o sistema grava a carteira".

**Medido:** **3 reprovados** de 7 (`carteira_sem_ator` em todos). Além do caso
previsto, os dois seguintes — "viewer/revogado" e "contato de outra org" — também
falham, e é CORRETO: eles chamam a mesma porta com ator nulo e esperam a recusa
ESPECÍFICA (`carteira_dono_invalido`, `carteira_contato_de_outra_organizacao`);
com a porta fechada o motivo chega trocado. A previsão errou o número, não a
régua: a sabotagem é pega, e as duas falhas extras apontam o mesmo buraco.

### S2 · ação: a ação manda a origem humana em vez da origem do sistema
`p_origem: "automacao"` → `p_origem: "manual"`.

**Previsão:** o unitário "com `contato` ligado…" reprova na asserção dos argumentos.
**Medido:** exatamente 1 reprovado de 11, esse. ✅

## Perna 2 — as conversas abertas

### S3 · ação: passa também a conversa SEM dono (fila/IA)
sai o `conversa.assigned_to_user_id !== null &&` do filtro.

**Previsão:** o unitário de conversas reprova por chamada a MAIS.
**Medido:** exatamente 1 reprovado de 11, esse. ✅

### S4 · ação: sai o filtro de status — a conversa ENCERRADA volta a ser alcançável
sai o `.not("status", "in", ...)`.

**Previsão:** o mesmo unitário reprova na asserção do filtro.
**Medido:** exatamente 1 reprovado de 11, esse. ✅

### S5 · ação: a passagem deixa de ser opt-in (o defeito de desenho que a issue proíbe)
`opcoesDePassagem` devolve `{ contato: true, conversas: true }` sempre.

**Previsão:** reprovam "com as duas opções desligadas" e o `false` explícito.
**Medido:** **7 reprovados** de 11 — os dois previstos e mais cinco, porque forçar
a passagem muda o `detail` de todos os casos com as caixas desligadas. A régua
pega o defeito; o número maior só mostra o alcance dele. ✅

## O que a sabotagem NÃO cobriu
- A conversa fechada no BANCO: o filtro é da consulta, não da `fn_conversation_assign`;
  o lado do banco da atribuição já era coberto por `rodizio`/`assignment` antes desta
  entrega e não mudou.
- Concorrência real na transferência (`p_expected_assignee`): o dublê devolve o que a
  função devolveria; o comportamento da função não foi alterado.
