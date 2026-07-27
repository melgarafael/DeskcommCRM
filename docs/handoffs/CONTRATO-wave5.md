# Wave 5 — as condições, reescritas para colar

> @Arquiteto → @Assistente e Testes · carimbo **HEAD 083aeb3**, `supabase/migrations/…0074…sql` já no disco.
> Incorpora o veredito da regência (faixa **persistida** + CHECK de coerência) e as quatro que faltavam.

---

## C1 — O score é FÓRMULA DETERMINÍSTICA, nunca chamada de modelo
`lib/leads/probability.ts`, pura, sem I/O, `now` injetado. Sinais e pesos **fixos em código** como
decisão de produto congelada: qualificação 35 · saldo compromissos×objeções 30 · avanço no funil 20 ·
vitalidade 15.

**Por quê é condição e não preferência:** com fórmula o `reason` é **derivado do cálculo** — "número sem
porquê" vira impossível por construção, e construção vale mais que constraint. Com modelo, a Lei D é
cumprida **na aparência**: frase gerada não é derivação, e o número não se audita até a origem.
*Sem esta condição, um scorer por LLM satisfaz todas as outras e mata a wave.*

## C2 — A recência CONSOME `classifyRisk` / `resolveStageWindow` — janela nova é rejeição automática
O sinal de vitalidade lê o bucket de `classifyRisk` (`lib/leads/risk-radar.ts`) e a janela vem de
`resolveStageWindow`. **Proibido** qualquer limiar de tempo próprio dentro da fórmula.

**Por quê:** §3.3 já declara que um segundo classificador de esfriamento é rejeição automática. Dentro de
um cálculo é o **pior lugar possível** para escondê-lo — ninguém vai procurar lá, e board e `/app/radar`
passariam a discordar sobre o mesmo lead. É a doença que a entrega existe para curar, cometida dentro
da cura.

## C3 — Sem sinal suficiente ⇒ `null`, **nunca zero**; e vitalidade NÃO conta para o mínimo
Exige **≥2 sinais com conteúdo**, e o sinal de vitalidade **não** entra nessa contagem —
*vitalidade modula, não afirma*.

**Por quê:** zero é uma afirmação ("não vai fechar"); `null` é a ausência de afirmação. Um lead criado à
mão há cinco minutos tem estágio e recência e **nada** a dizer sobre fechar. Sem a cláusula, o cenário 17
falha **por dentro**, com aparência de sucesso.

## C4 — As três constraints na FORMA MEDIDA (não na intenção)
A tríplice de migration diz **onde** escrever; isto diz **o quê**. Medido em Postgres 17 descartável:

```sql
-- 1. número sem porquê não entra
check (ai_probability is null
       or (ai_probability_reason is not null and length(btrim(ai_probability_reason)) > 0))

-- 2. faixa 0..100 — numeric(5,2) aceita até 999.99; sem isto um bug de fórmula grava 340%
check (ai_probability is null or (ai_probability >= 0 and ai_probability <= 100))

-- 3. afirmação sem lastro não entra — NULL-safe E type-safe
check (ai_probability is null
       or coalesce(jsonb_typeof(ai_probability_evidence->'activity_ids') = 'array'
                   and jsonb_array_length(ai_probability_evidence->'activity_ids') > 0, false)
       or coalesce(jsonb_typeof(ai_probability_evidence->'message_ids') = 'array'
                   and jsonb_array_length(ai_probability_evidence->'message_ids') > 0, false)
       or coalesce(jsonb_typeof(ai_probability_evidence->'checkpoint_ids') = 'array'
                   and jsonb_array_length(ai_probability_evidence->'checkpoint_ids') > 0, false))
```
> **Os dois detalhes não são zelo, são medição.** Sem o `coalesce`, chave ausente faz `jsonb_typeof`
> devolver NULL, a expressão inteira vira NULL e **CHECK com NULL PASSA** — a trava aceitaria tudo.
> Sem o guarda de tipo, valor escalar levanta **22023** (`cannot get array length of a scalar`), que é
> SQLSTATE diferente de 23514: vira **500** onde deveria ser 422.

## C5 — Validade e proveniência
- **Score velho aparece apagado**, não sumido e não como corrente. Velho é `ai_probability_at <
  last_activity_at` — a definição dá a regra, não há TTL a arbitrar.
- **`formula_v` dentro do `evidence`.** Sem ele, score velho de outra fórmula comparado com novo é maçã
  com pera, e a descoberta vem seis meses depois, quando os números param de bater e não há como saber
  qual fórmula produziu qual.

---

## C6 — A FAIXA É PERSISTIDA (veredito da regência — eu estava errado)
Histerese é função **dependente de caminho**: a faixa não é derivável do último score. **Concedido.**

E a variante sem memória falha **pior** do que piscar — ela **engole travessia real**: com prev=69 e
now=71 não dispara (correto), mas deixa `prev` acima do corte; quando o score sobe de verdade para 76,
a regra "prev < corte" é falsa e **nada dispara**. Trocaria piscar por silêncio, que pela nossa própria
regra de assimetria é a falha cara.

**Mas o risco da duplicação vira CHECK DE COERÊNCIA** — divergência tem de ser **impossível de gravar**,
não improvável. Com cortes 40/70 e banda 5, as transições são: `frio→morno` ≥45 · `morno→frio` ≤35 ·
`morno→quente` ≥75 · `quente→morno` ≤65. Logo, **enquanto** numa faixa:

```sql
check (
  ai_probability_band is null
  or (ai_probability is not null and (
        (ai_probability_band = 'frio'   and ai_probability <= 45)
     or (ai_probability_band = 'morno'  and ai_probability >= 35 and ai_probability <= 75)
     or (ai_probability_band = 'quente' and ai_probability >= 65)))
)
```
**Duas correções à proposta da regência:**
1. **`morno` precisa de limite.** Sem ele, `morno` com score 92 é gravável — faixa velha enquanto o
   score disparou, que é exatamente a divergência que o CHECK existe para impedir. Faltava um dos três.
2. **Faixa sem score é impossível** (`ai_probability is not null`): faixa é a memória de uma travessia;
   sem número não houve travessia.
- E `ai_probability_band_since` acompanha: `(band is null) = (band_since is null)`.

**A regra de transição continua no TypeScript** — a coluna é só a memória dela. Cortes e banda numa
**const única** exportada, consumida pelo emissor **e** pela UI. Rótulos em
`satisfies Record<Faixa, string>` — nunca `Record<string, string>`, que aceita qualquer chave e não
exige nenhuma.

## C7 — Histerese: banda morta, e o teste com DOIS osciladores
Cortes 40/70, banda 5 (sobe em 75, desce em 65).
- **Oscilação pequena** em volta do corte (73/75/73) ⇒ emite **UMA** vez.
- **Oscilação por vitalidade** ⇒ emite **AS DUAS**: `classifyRisk` indo e voltando move 15 × 0,7 = 10,5
  pontos e **atravessa** a banda, e "esfriou"/"voltou" são mudanças reais de estado.

*Só com o caso sintético o teste prova que a histerese cala — nunca que ela deixa passar o que deve passar.*

## C8 — Evidência citável, e o `CardInput` precisa crescer
Cada fator carrega **texto legível** e, **onde existe momento de conversa**, âncora
`{conversation_id, message_id}`. Qualificação e avanço no funil **vão sem âncora**:
**âncora inventada é pior que âncora ausente** — é a Lei D cumprida na aparência.

**Correção minha, já declarada:** `probability` no `CardInput` (`lib/kanban/card-state.ts` @083aeb3) é
**número nu**. O campo tem de crescer para levar `reason` e os fatores, senão o hover não tem o que
mostrar. Eu havia escrito "a assinatura não muda" — **era falso**, e é mudança pequena e necessária.

## C9 — Recálculo NÃO emite atividade; travessia de faixa, sim
Score de 71 para 73 não muda o que alguém faria a seguir ⇒ telemetria. Emissão só na travessia, com
`reason` dizendo o que mudou. E o teto de ruído conta apenas `actor_kind in ('ai','system','rule')` —
clique humano é a única linha da timeline que contém **decisão**, não relato.
