# Evidência visual — Nível 1 (2026-11-26)

Capturas da imagem Ânima construída localmente (`docker build` com o `Dockerfile` do fork, commit
`fix(anima): ícones com peso regular explícito também saem bold`), rodando contra um Supabase local
com o `supabase/baseline.sql` e o dono criado por `scripts/bootstrap-owner.ts`. Envs opcionais
ausentes (sem IA, sem SMTP, sem WAHA).

- **Telas:** login, Inbox, Funis (`/app/kanban`), Contatos, Configurações, Marca, Aparência e
  `/admin/marca`, nos temas `dark-*` e `light-*` (1440×900, Playwright).
- **Onboarding:** marcado como concluído direto no banco (`organizations.onboarded_at`) para chegar
  às telas. O assistente em si não foi percorrido.
- **Azul remanescente** (`relatorio.json`): para cada elemento visível, `color`,
  `background-color` e `border-top-color` (com borda) com matiz entre 195° e 255°. Resultado:
  nenhum, nas 16 capturas. A sonda foi sabotada com um `div` em `rgb(37, 99, 235)` e o acusou.
- **Aparência:** `/app/settings/aparencia` redireciona para `/app/settings/marca` nos dois temas.
- **Ícones:** o ícone Inbox do menu sai com o desenho bold do Phosphor (`M208,28H48A20…`; o regular
  é `M208,32H48A16…`).

Fora do alcance desta rodada: telas além das listadas, onde o upstream ainda tem 16 classes de azul
cru (`git grep -nE "(bg|text|border|ring|from|to)-(blue|sky|indigo)-[0-9]{2,3}" -- app components`),
que são vazamentos do Nível 2; e logo e nome Ânima Hub, que dependem de PNG para o `/admin/marca`.
