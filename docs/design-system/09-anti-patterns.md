# 09 — Anti-patterns

> **Quando em dúvida, consulte aqui antes de implementar.** Cada item tem o "por quê" curto.

Lista canônica do que **não fazer** no SonghaiCRM. Anti-patterns ficam aqui pra preservar identidade visual e evitar convergência ao padrão SaaS genérico.

---

## 1. ❌ Inter como font family

**Por quê:** ~70% dos SaaS atuais usam Inter. É correta, mas saturada. Diluição de marca.
**✅ Sim:** Atkinson Hyperlegible (display + body) + IBM Plex Mono (dados). Ver `03-typography.md`.

---

## 2. ❌ Geist Sans, Space Grotesk, ou qualquer Vercel-default

**Por quê:** mesma razão de Inter. Geist é a "nova Inter" de 2024–2025. Anti-genérico exige distância.
**✅ Sim:** Atkinson.

---

## 3. ❌ Gradient roxo/azul/rosa em hero ou primary button

**Por quê:** símbolo do "AI SaaS 2024". Datado e clichê. Não combina com soft-tech calmo.
**✅ Sim:** solid `accent-500` (verde-WhatsApp `#169b80`). Profundidade vem de border + shadow neutro, não gradient.

---

## 4. ❌ `bg-zinc-900` ou `bg-slate-900` em dark mode

**Por quê:** zinc/slate são cool-gray geométricos. A paleta é warm (greige). Misturar quebra coerência.
**✅ Sim:** `bg: #161510` (warm dark canônico). Ver `02-palette-sage.md`.

---

## 5. ❌ Glassmorphism (`backdrop-filter: blur` em cards/sidebar)

**Por quê:** efeito decorativo que custa GPU, não comunica nada funcional, sai de moda. Mais task que valor.
**✅ Sim:** solid `surface` ou `surface-elevated` com `border-thin`.

---

## 6. ❌ `Sparkle` ou `Sparkles` icon pra IA

**Por quê:** clichê 2023–2024. Comunica "feature de marketing" mais que função.
**✅ Sim:** `Brain` (Phosphor duotone) pra "processamento", `MagicWand` pra "sugestão automática" raro. `Lightning` é reservado pra **shortcuts/templates do atendente**, não IA.

---

## 7. ❌ Lucide Icons (default shadcn)

**Por quê:** ~80% dos shadcn-based usam Lucide. Genérico por convergência.
**✅ Sim:** Phosphor com peso `duotone` default. Ver `05-iconography-phosphor.md`.

---

## 8. ❌ Accent (verde-WhatsApp) como bg de toda a sidebar

**Por quê:** a sidebar é greige (`surface` ou `surface-elevated`). Accent na sidebar fica saturado e cansa em 8h.
**✅ Sim:** sidebar `surface`, com hover `accent-soft` em items de nav, active `accent-soft` + text `accent`.

---

## 9. ❌ Animar tudo no mount da página (cascade decorativa)

**Por quê:** stagger pesado custa CPU, atrasa interatividade, e em retorno (após reload) vira ruído.
**✅ Sim:** stagger sutil **só** em primeiro carregamento (40–290ms delay), `prefers-reduced-motion` respeitado. Itens que entram via scroll/refetch sem animação.

---

## 10. ❌ `red-500` puro (#ef4444) pra error

**Por quê:** vermelho saturado em UI calma vira alarme. Quebra o tom soft-tech.
**✅ Sim:** `error: #a94a3c` (light) ou `#c87263` (dark). Saturação ≤ 55%. Ver `02-palette-sage.md`.

---

## 11. ❌ 3+ cards shadcn empilhados em grid 3-cols como "stats overview"

**Por quê:** padrão dashboard genérico. Cada card vira ruído de baixo signal-to-noise.
**✅ Sim:** se precisa stats overview, use **inline metrics** (texto grande + label, sem container) ou **1 card largo** com várias métricas dentro separadas por divider.

---

## 12. ❌ "Oops! Algo deu errado 😬"

**Por quê:** voz casual em momento crítico. Cliente perdeu dado, não quer hand-holding.
**✅ Sim:** "Não conseguimos completar essa ação. Tente novamente em instantes." Ver `08-voice-and-tone.md`.

---

## 13. ❌ Emoji em UI funcional (botão, toast, error, success)

**Por quê:** infantiliza voz, polui screenshots de debug, atrapalha screen readers.
**✅ Sim:** ícone Phosphor com cor semântica + texto sóbrio.

---

## 14. ❌ Exclamation marks em sucesso ("Salvo com sucesso!")

**Por quê:** celebração de evento mundano. Gera fadiga emocional ao longo do dia.
**✅ Sim:** "Salvo." (com ponto). Resolução é a recompensa.

---

## 15. ❌ Sombras com preto puro (`rgba(0,0,0,0.X)`)

**Por quê:** preto puro contra warm-bg vibra (gera halo cinza). Quebra coerência.
**✅ Sim:** `rgba(20, 18, 14, X)` — cor do texto neutro. Ver `01-foundation-tokens.md` § Shadow.

---

## 16. ❌ `#fff` puro como bg de página em light mode

**Por quê:** branco puro reflete demais em sessão longa, causa fadiga.
**✅ Sim:** `bg: #faf9f6` (offwhite warm). `surface` (cards) sim usa `#ffffff` puro pra contraste.

---

## 17. ❌ `border-radius: 0` em todos os controles ("flat brutalism")

**Por quê:** brutalist é uma direção válida, mas não combina com soft-tech calmo. Vira hostil em uso prolongado.
**✅ Sim:** `radius-xs` (4px) em controles, `radius-sm` (8px) em cards de lista. Radius 0 só em tabelas densas.

---

## 18. ❌ Tabs com background pill (`bg-accent-soft` no active)

**Por quê:** padrão tablets-iOS, ocupa visual demais em UI densa.
**✅ Sim:** underline-style — `border-bottom-color: accent` (2px) + `text-accent`. Ver `06-components.md`.

---

## 19. ❌ Spinner em botão sem desabilitar o botão

**Por quê:** clique duplo manda 2 requests. Bug clássico.
**✅ Sim:** `<Button disabled loading><CircleNotch /> Salvando.</Button>`

---

## 20. ❌ "Usuário não logado" / "Algo está errado" como mensagens

**Por quê:** vagas, não acionáveis, frustram.
**✅ Sim:** "Sua sessão expirou. **Entrar novamente.**" / "Não conseguimos buscar essa lista. Verifique sua conexão e tente de novo."

---

## 21. ❌ Tooltip em botão com label visível

**Por quê:** redundante. Tooltip é pra informação extra que não cabe no controle.
**✅ Sim:** tooltip só em icon-only buttons ou quando há atalho de teclado pra mostrar (`Buscar (⌘K)`).

---

## 22. ❌ Modal dentro de modal

**Por quê:** Z-stack confusa, foco perdido, anti-padrão de UX.
**✅ Sim:** se precisa segundo step, vire wizard dentro do mesmo modal, ou use Sheet → Dialog (1 nível só).

---

## 23. ❌ `transition: all`

**Por quê:** anima width/height (caras), perde controle de quais props transicionam.
**✅ Sim:** liste explicitamente — `transition: background 120ms, border-color 120ms`. Ver `07-motion-language.md`.

---

## 24. ❌ Texto centralizado em cards de dados

**Por quê:** centralizar quebra hierarquia de leitura ocidental (esquerda → direita). Aceitável só em empty states e CTAs heroicos.
**✅ Sim:** alinhamento à esquerda em title, body, value. Right-align só pra metas (timestamp, badge, value monetário).

---

## 25. ❌ `cursor: pointer` em containers não-clicáveis

**Por quê:** mente o usuário sobre affordance.
**✅ Sim:** `cursor: pointer` apenas em elementos com `onClick`. Card que tem subelementos clicáveis usa cursor `default`.

---

## Como usar este doc

Antes de mergear PR de UI:

1. Pesquise o termo (`Ctrl+F`) que você está usando — se aparece como "❌", você está fazendo algo errado.
2. Se sua intuição diz "isso fica bonito", e o briefing não pediu — provavelmente é anti-pattern. Pause.
3. Se descobre um anti-pattern novo no produto, adicione aqui em PR — anti-patterns são o memory bank do design system.
