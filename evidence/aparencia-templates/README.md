# Aparência: os dez templates pela tela (14/11/2026)

**Tipo:** REPRODUZÍVEL — capturas da própria spec `tests/e2e/aparencia-templates.spec.ts`, que as regrava a cada execução.

**Contra qual código:** branch `feat/temas-de-aparencia` sobre `bdd75fe2d`, build de produção (`pnpm e2e:build` + `next start`), banco local pg15 com o `baseline.sql` desta branch, sem envs opcionais. Conta de teste `e2e-admin` semeada por `scripts/seed-e2e-credentials.ts`; a organização não tem contatos (por isso o estado vazio).

## A tela

| Captura | O que prova |
|---|---|
| [tela-aparencia.jpg](tela-aparencia.jpg) | A galeria com as miniaturas reais (claro e escuro de cada template, pintadas pelos tokens do próprio template), o "Padrão do sistema" em uso e a personalização. |
| [tela-aparencia-previa-aurora.jpg](tela-aparencia-previa-aurora.jpg) | Visualizar a Aurora: o menu e o topo da casca mudam na hora, a barra "Prévia" fica à vista ao rolar e nada foi gravado. |
| [vinho-celular-menu.jpg](vinho-celular-menu.jpg) | 390×844 com o Vinho aplicado: sem estouro de largura e com o botão principal na cor do template. |

## Os dez templates em Contatos, claro e escuro

Cada par é a tela de Contatos com o template aplicado pela tela; a spec confere `--color-bg` do template em cada modo antes de capturar.

| Template | Claro | Escuro |
|---|---|---|
| Obsidiana | [obsidiana-claro.jpg](obsidiana-claro.jpg) | [obsidiana-escuro.jpg](obsidiana-escuro.jpg) |
| Aurora | [aurora-claro.jpg](aurora-claro.jpg) | [aurora-escuro.jpg](aurora-escuro.jpg) |
| Safira | [safira-claro.jpg](safira-claro.jpg) | [safira-escuro.jpg](safira-escuro.jpg) |
| Carbono | [carbono-claro.jpg](carbono-claro.jpg) | [carbono-escuro.jpg](carbono-escuro.jpg) |
| Mármore | [marmore-claro.jpg](marmore-claro.jpg) | [marmore-escuro.jpg](marmore-escuro.jpg) |
| Coral | [coral-claro.jpg](coral-claro.jpg) | [coral-escuro.jpg](coral-escuro.jpg) |
| Néon | [neon-claro.jpg](neon-claro.jpg) | [neon-escuro.jpg](neon-escuro.jpg) |
| Lavanda | [lavanda-claro.jpg](lavanda-claro.jpg) | [lavanda-escuro.jpg](lavanda-escuro.jpg) |
| Ártico | [artico-claro.jpg](artico-claro.jpg) | [artico-escuro.jpg](artico-escuro.jpg) |
| Vinho | [vinho-claro.jpg](vinho-claro.jpg) | [vinho-escuro.jpg](vinho-escuro.jpg) |

**Não medido pela tela:** Safari e Firefox; as demais telas de cada módulo uma a uma (herdam os mesmos tokens); organização com tema de extensão e template ao mesmo tempo.
