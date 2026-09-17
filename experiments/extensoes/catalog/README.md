# Catálogo local de ensaio

Este processo usa apenas a biblioteca padrão do Python e um banco SQLite próprio. Ele não acessa o
banco da aplicação, não precisa de Docker e serve somente artefatos imutáveis em `127.0.0.1`.
O arquivo do catálogo para admissão é exportado separadamente e nunca é servido por HTTP.

Depois de construir a aplicação, crie e publique o pacote de ensaio:

```bash
pnpm build
python3 experiments/extensoes/catalog/catalog.py init \
  --db /tmp/extensions-catalog.sqlite \
  --origin http://127.0.0.1:8787
python3 experiments/extensoes/catalog/catalog.py make-example \
  --output /tmp/tasks-guide.json
python3 experiments/extensoes/catalog/catalog.py publish \
  --db /tmp/extensions-catalog.sqlite \
  --manifest /tmp/tasks-guide.json
python3 experiments/extensoes/catalog/catalog.py export \
  --db /tmp/extensions-catalog.sqlite \
  --output /tmp/extensions-catalog-admission.json
```

Admita `/tmp/extensions-catalog-admission.json` pela aplicação e, somente durante o ensaio, inicie
o servidor de pacotes:

```bash
python3 experiments/extensoes/catalog/catalog.py serve \
  --db /tmp/extensions-catalog.sqlite \
  --host 127.0.0.1 \
  --port 8787
```

Encerre com `Ctrl-C` ao terminar. Uma nova versão usa outro valor `version`; a CLI recusa trocar os
bytes de uma identidade já publicada. Cada `export` cria uma revisão monotônica e um arquivo novo.

Teste focado:

```bash
python3 -m unittest experiments/extensoes/catalog/test_catalog.py -v
```
