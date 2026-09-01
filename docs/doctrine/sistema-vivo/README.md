# Sistema Vivo — Manual de Arquitetura

> Um método para construir software que **não deixa nada morrer dentro dele**.

Este é o manual. A **lei curta e verificável** vive em [`../sistema-vivo.md`](../sistema-vivo.md) — é ela que o Definition of Done cobra e o CI vigia. O manual existe para responder *por quê*, e para que a doutrina possa ser adotada por um sistema que não é este.

---

## Para quem é

- **Quem implementa uma peça** neste sistema (ou em outro que adote a doutrina) e precisa saber onde ela se conecta. → capítulos 2 e 8.
- **Quem projeta um sistema novo** e quer o método antes do código. → capítulos 1 a 7, em ordem.
- **Quem quer entender o raciocínio** sem intenção de implementar. → capítulo 1, depois 3.

---

## A convenção plugável

Cada capítulo tem duas partes, sempre nesta ordem:

| Parte | Conteúdo | Ao publicar | Ao adotar |
|---|---|---|---|
| **Princípio** | Universal. Vale para qualquer software que atenda pessoas. Não cita tabela, arquivo ou framework. | É isto que sai. | É isto que você lê. |
| **Aplicação de referência** | Como o SonghaiCRM materializa o princípio. Cita tabela, arquivo, teste. | Fica de fora, ou entra como estudo de caso nomeado. | Você **reescreve** esta seção para o seu sistema. |

A separação não é estética. É o que permite que a doutrina seja verdadeira em mais de um lugar: um princípio que só se sustenta citando `crm_leads` nunca foi um princípio, era uma descrição.

**Regra de escrita:** se você precisou nomear um artefato do repositório para a frase fazer sentido, ela pertence à Aplicação de referência. Se ela sobrevive sem nenhum nome próprio, é Princípio.

---

## Os capítulos

| # | Capítulo | Responde |
|---|---|---|
| 1 | [Fundamentos](01-fundamentos.md) | O que é um sistema, e por que o comportamento não está nas peças |
| 2 | [A lei dos invariantes](02-lei-dos-invariantes.md) | As 7 propriedades que toda peça precisa ter |
| 3 | [A medida do propósito](03-medida-do-proposito.md) | Como medir o que o sistema promete, e não o que é fácil contar |
| 4 | [Fronteira de autoridade](04-fronteira-de-autoridade.md) | Quem decide o quê entre IA, humano e sistema — e onde isso vaza |
| 5 | [A unidade de demanda](05-unidade-de-demanda.md) | Por que o objeto central é o problema, não o cliente |
| 6 | [O tempo do sistema](06-tempo-do-sistema.md) | Onde tempo real ajuda, onde ele destrói |
| 7 | [O projeto como sistema](07-o-projeto-como-sistema.md) | Adoção, contribuição e sustentação sob os mesmos invariantes |
| 8 | [Aplicação](08-aplicacao.md) | O checklist, as receitas e os gates |

**Ordem sugerida na primeira leitura:** 1 → 2 → 8. Os capítulos 3 a 7 aprofundam um invariante cada e podem ser lidos sob demanda.

---

## Precedência

Quando duas fontes discordarem, vale nesta ordem:

1. **A lei** — [`../sistema-vivo.md`](../sistema-vivo.md). É o texto que o DoD cobra e o CI verifica.
2. **Este manual** — o racional e a extensão da lei.
3. **Doutrinas irmãs** — [`../restricao-de-canal.md`](../restricao-de-canal.md), [`../separacao-fala-e-operacao.md`](../separacao-fala-e-operacao.md), que aplicam a lei a um eixo específico.

Se o manual contradiz a lei, a lei ganha e **o manual está com defeito** — corrija-o na mesma sessão. Doutrina que diverge de si mesma deixa de ser consultada em uma semana.

---

## Adotar isto em outro sistema

O manual foi escrito para viajar. O caminho mínimo:

1. Copie `docs/doctrine/sistema-vivo/` e `docs/doctrine/sistema-vivo.md`.
2. **Reescreva todas as seções "Aplicação de referência"** para os artefatos do seu sistema. Enquanto elas citarem o SonghaiCRM, a doutrina é decoração.
3. Declare o propósito do seu sistema em **estado terminal**, não em atividade (capítulo 3). Sem isso, nada mais funciona.
4. Escolha a sua unidade de demanda (capítulo 5).
5. Ligue **um** gate mecânico no CI antes de qualquer outro — o mais barato que reprova de verdade (capítulo 8). Doutrina sem gate é intenção.

Do 1 ao 5 é meio dia de trabalho e é o que separa "temos uma doutrina" de "a doutrina está valendo".

---

## Estado

| | |
|---|---|
| **Versão** | 1.0 |
| **Criado** | 2026-08-06 |
| **Lei correspondente** | [`../sistema-vivo.md`](../sistema-vivo.md) |
| **Skill operacional** | `.claude/skills/sistema-vivo/SKILL.md` |
| **Implementação de referência** | SonghaiCRM |

**Ao mudar a lei, este manual desatualiza.** O capítulo 2 é o espelho direto de `../sistema-vivo.md` — mudou um invariante lá, atualize aqui na mesma sessão, ou os dois textos começam a mentir um sobre o outro.
