# Avatar do assistente de ajuda: o Strobi

O rosto do ajudante é o **Strobi**, avatar oficial criado no **Avatar Lab**
([avatars.bible-strong.app](https://avatars.bible-strong.app/)) e renderizado
pela lib `@bible-strong/avatar-react` a partir de um dado versionado:

- `components/assistente/strobi.avatar.json` — a definição exportada no Lab;
- `components/assistente/AssistenteAvatar.tsx` — cria o componente com
  `createAvatar(definition)` e dirige as animações (`idle`, `listening`,
  `happy`) e os olhares (`far-right-glance`, `curious-left`,
  `upward-side-glance`, `downward-gaze`) conforme mouse, clique e chat;
- `components/assistente/strobi.test.ts` — quebra no CI se a definição for
  trocada por uma que não tenha essas chaves.

Nada é baixado do site do Avatar Lab em runtime: funciona offline e no
self-host, e o `pnpm install` de uma instalação fresca resolve a lib do
registry público normalmente.

## Trocar de avatar

1. Monte o novo avatar no Avatar Lab.
2. Exporte o **`.avatar.json`** (a definição, não o projeto demo).
3. Sobrescreva `components/assistente/strobi.avatar.json` com o arquivo novo.
4. Rode `pnpm vitest run components/assistente` — se o teste reclamar de
   chave ausente, ajuste os nomes em `AssistenteAvatar.tsx` (ou escolha outro
   avatar no Lab que tenha as mesmas animações).
5. Rebuild/redeploy.

## Notas

- A pasta `avatar/` com o projeto demo Vite que o Lab exporta junto NÃO mora
  neste repo — só a definição `.avatar.json` é necessária.
- Se a lib recusar a definição em runtime, o botão cai para um SVG estático
  simples em vez de quebrar a página (ver `onError` no componente).
- Licença: confira os termos do Avatar Lab antes de publicar o avatar num
  produto comercial (white-label).
