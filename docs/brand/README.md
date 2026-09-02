# Marca

## Social preview (Open Graph)

`og-social-preview.png` — 1280×640, é a imagem que aparece quando um link do
repositório é compartilhado no X, LinkedIn, WhatsApp, Slack ou Discord.

**Como aplicar:** GitHub → Settings → General → *Social preview* → Upload.
Não existe endpoint público na API para isso; é upload pela interface.

**Como regerar** (depois de mudar posicionamento, chips ou paleta):

```bash
# edite docs/brand/og-card.html, depois:
node -e '
import("@playwright/test").then(async ({ chromium }) => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  await p.goto("file://" + process.cwd() + "/docs/brand/og-card.html", { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: "docs/brand/og-social-preview.png" });
  await b.close();
});'
```

A fonte fica versionada de propósito: card cuja origem se perde vira arte que
ninguém consegue atualizar quando o posicionamento muda — e aí ou envelhece
mentindo, ou é refeito do zero com outra identidade.

## Regras da arte

- Paleta lida de `app/globals.css` (creme `#faf9f6`, verde-WhatsApp `#008069`, texto
  `#1c1a16`). O card usa a identidade real do produto, não uma criada para ele.
- Tipografia: Atkinson Hyperlegible (títulos) + IBM Plex Mono (rótulos), as
  mesmas da aplicação.
- O painel direito é a doutrina do sistema vivo virando imagem: o rastro que uma
  demanda deixa ao atravessar o sistema, terminando no follow-up — o mecanismo
  anti-morte. É o argumento do produto mostrado, não adjetivado.
- Card de compartilhamento **sempre** carrega o nome do produto. Sem wordmark,
  quem vê a imagem não sabe de quem ela é.
