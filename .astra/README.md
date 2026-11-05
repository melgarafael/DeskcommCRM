# O que é só da Astra neste fork

Fork `Jutaosorio/DeskcommCRM` (upstream: `melgarafael/DeskcommCRM`). O upstream não tem
`.astra/`, então nada aqui conflita numa sincronização.

## O que existe só aqui

- **Skill `atualizar-crm-custom`** (`.agents/skills/`, com espelho em `.claude/skills/` via
  `pnpm skills:sync`): sincroniza com o upstream e faz o deploy na VPS. O nome não começa com
  `deskcomm-` de propósito: o teste `skills-embutidas` exige que toda skill `deskcomm-*` seja
  citada em arquivos do upstream, o que daria conflito a cada sincronização.
- **`.astra/local/`**: ignorada pelo git. Guarda ssh, pasta e domínio da VPS e a lista de termos
  proibidos. O fork é público, então nada de cliente ou servidor entra no git. Como preencher:
  `.agents/skills/atualizar-crm-custom/references/instancia.md`.
- **`.github/workflows/contrato-upstream.yml`**: vigia semanal, só em fork. Agendamento em fork
  nasce desligado: habilite uma vez em Actions › contrato-upstream › Enable workflow.

## Divergências do upstream

| O que mudamos | Onde |
|---|---|
| Tema escuro "Linear Dark" | `app/globals.css` |
| E2E desligado (os minutos do Actions vão para o build das imagens) | `.github/workflows/e2e.yml` |
| Stack local de staging com as imagens da Astra | `docker-compose.local-vps.yml` |
| Heap do build | `Dockerfile` |

### Ajustes que vivem no `.env` da VPS (não no git)

O `docker-compose.prod.yml` é **idêntico ao do upstream**: o que a Astra muda ali entra pelo `.env`.

- `WORKER_MEM_LIMIT=2048m` (padrão do upstream é 512m). Com 512m o worker caiu 14 vezes em 3 h por
  `JavaScript heap out of memory` na v1.85 (transcrição de áudio e turnos do agente). Até a v1.99
  isso era uma edição do compose; desde a v1.102 é o knob do upstream. **Sem essa linha no `.env`
  o worker volta a 512m.** O deploy escreve e o passo `depois` confere.

### Testes do upstream que a gente ajusta

Ao sincronizar, se um destes falhar, **reaplique o ajuste no teste**; não desfaça a customização.

- `tests/unit/branding-pares-pintados.test.ts`: linhas com `ASTRA` (o tema escuro tem contraste
  maior que o do upstream).
- `tests/unit/skills-embutidas.test.ts`: `ORCAMENTO_DESCRICOES` 6000 → 6500 (cabe a skill nova).
  O `.gitignore` também libera `.claude/skills/atualizar-crm-custom/`.
- `tests/unit/gatilho-dos-jobs-de-entrega.test.ts`: uma entrada em `GATILHO_ESPERADO`, marcada
  `ASTRA` (o vigia do contrato, que só existe em fork).

## Pendente

**O job `invariants` reprova** (na `main` do fork e em todo PR). O script
`scripts/conferir-isolamento-do-kit.sh` precisa de uma release publicada no `origin` e da tag
`v1.63.0`. Conserto: publicar uma release por sincronização (ex.: `v1.88.0-astra.1`) e levar as
tags do upstream ao fork, no máximo 3 por vez, porque cada push de tag `v*` dispara o
`publish-image.yml`.
