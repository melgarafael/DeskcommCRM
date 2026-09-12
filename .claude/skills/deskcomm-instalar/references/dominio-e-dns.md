# Domínio, DNS e o proxy que já existe

## O que precisa existir

Um registro **A** ligando o nome que a pessoa escolheu (ex.: `crm.suaempresa.com.br`) ao IP da
VPS. Só isso. O certificado (o cadeado) é emitido sozinho pelo Caddy do kit — ou pelo proxy da
hospedagem, quando ela já tem um — assim que o nome apontar para o servidor.

Descubra o IP da VPS de dentro dela: `curl -s https://api.ipify.org`.

## Passo a passo por registrador (linguagem de quem nunca fez)

Abra o painel onde o domínio foi comprado e procure "DNS", "Zona DNS" ou "Gerenciar DNS".

| registrador | onde clicar | o que preencher |
|---|---|---|
| **Registro.br** | Painel → domínio → *Editar zona* (se o domínio usa os servidores DNS do Registro.br) | *Tipo* `A`, *Nome* `crm` (o subdomínio; vazio ou `@` para o domínio raiz), *Dados* o IP da VPS |
| **GoDaddy** | *Meus produtos* → domínio → *DNS* → *Adicionar registro* | *Tipo* `A`, *Nome* `crm`, *Valor* o IP, *TTL* padrão |
| **Cloudflare** | *DNS* → *Records* → *Add record* | *Type* `A`, *Name* `crm`, *IPv4* o IP, **Proxy status: DNS only (nuvem cinza)** — a laranja esconde o IP e o instalador diz que o domínio não aponta para cá; volte para laranja só depois do cadeado, se quiser |
| **Hostinger / HostGator (painel de domínio)** | *Domínios* → domínio → *DNS / Zona DNS* | igual: `A`, `crm`, IP |
| **Google Domains / Squarespace** | *DNS* → *Registros personalizados* | igual |

Se o domínio foi comprado num lugar e os servidores DNS apontam para outro (ex.: comprado na
GoDaddy, DNS na Cloudflare), o registro se cria **onde estão os servidores DNS**.

## Conferir se já valeu

```bash
getent ahosts crm.suaempresa.com.br | awk '{print $1}' | sort -u
```

Se aparecer o IP da VPS, valeu. Costuma levar minutos; pode levar até algumas horas em
registradores lentos. O instalador **espera junto**: Enter reconsulta, `c` continua sem cadeado
(o site sobe em HTTP e o certificado sai quando o DNS valer), `s` sai guardando as respostas.

Um domínio pode ter também um registro **AAAA** (IPv6) apontando para outro lugar; o instalador
aceita desde que **um** dos endereços seja o da VPS. Se o cadeado não sair mesmo com o A certo,
apague o AAAA antigo.

## O proxy que já existe (antes de rodar o instalador)

Algumas hospedagens entregam a VPS com um proxy ocupando as portas 80/443. Descubra antes:

```bash
docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'
ss -ltnp | grep -E ':80 |:443 '
```

| o que você vê | o que fazer |
|---|---|
| nada nas portas | siga normal — o Caddy do kit cuida do certificado |
| contêiner `traefik` **publicando** 80/443 (Coolify, Dokploy, CapRover) | deixe o instalador detectar: ele grava `REVERSE_PROXY=traefik` e publica o CRM por etiquetas no Traefik da hospedagem |
| Traefik em `--network host` (Hostinger) — a coluna de portas sai vazia | o instalador **pergunta** se é ele quem atende o domínio; responda `s`. Em `--yes`, escreva `REVERSE_PROXY=traefik` no `.env` antes |
| `nginx`/`apache` do próprio sistema (CloudPanel, cPanel) | não é detectado. Prepare o `.env` seguindo `docs/runbooks/cloudpanel.md` (`REVERSE_PROXY=traefik` mais rede e entrypoints) **antes** de rodar |

Nunca desligue o proxy da hospedagem para "liberar as portas": ele é quem dá HTTPS ao que o painel
instala, e desligá-lo quebra as automações dela.

Nessas VPS, todo `docker compose ... up -d` leva os **dois** arquivos de compose (ver
`scripts-do-kit.md`); esquecer o segundo deixa o domínio inteiro em 404.

## Trocar o domínio depois

Rode `bash hostgator-setup-kit/install.sh` de novo, corrija o `DOMAIN` pelo número na tela de
conferência e aponte o registro A do domínio novo. Os links dos e-mails de acesso precisam
acompanhar: com o token do Supabase, `bash hostgator-setup-kit/marca-emails.sh` regrava Site URL e
Redirect URLs.
