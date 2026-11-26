# PATCHES — divergências do fork Ânima em relação ao upstream

Cada arquivo do upstream alterado pelo fork entra aqui. Depois de todo sync, percorra esta lista e
confirme que cada patch continua aplicado.

**Superfície permitida** (`AGENTS.anima.md` §3) — alterações esperadas, registradas para conferência
no sync:

| Arquivo | O que muda | Desde | Como reaplicar se o sync sobrescrever |
|---|---|---|---|
| `AGENTS.md` | 1ª linha: `> Fork Ânima: leia também [AGENTS.anima.md](AGENTS.anima.md) antes de qualquer tarefa.` | 2026-11-26 | Recolocar a linha no topo |
| `CLAUDE.md` | 1ª linha: `@AGENTS.anima.md` | 2026-11-26 | Recolocar a linha no topo |
| `README.md` | 1ª linha: banner apontando para `docs/anima/README.md` | 2026-11-26 | Recolocar a linha no topo |

**Fora da superfície permitida** (exige aprovação prévia):

| Arquivo | Motivo | Aprovado por / data | Como reaplicar |
|---|---|---|---|
| — | — | — | — |

**Valores copiados à mão do DS** (o pacote não exporta a variável):

| Token local | Valor | Motivo |
|---|---|---|
| — | — | — |

## Pendências conhecidas

- **Tema escuro como padrão:** o padrão também é decidido em `lib/theme.tsx` (fallback `"system"` →
  claro), fora da superfície permitida. Antes de alterar, é preciso aprovar e conferir o
  `lib/theme.test.tsx`.
