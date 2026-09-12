# Instalando para um cliente (agência, consultor, revendedor)

O DeskcommCRM é MIT e feito para ser revendido com a marca do cliente. O que muda quando quem
instala não é quem vai usar:

## De quem é cada coisa

| coisa | de quem deve ser | por quê |
|---|---|---|
| **VPS** | do cliente (contratada no nome dele), ou da agência com uma VPS **por cliente** | o WhatsApp roda 24h ali; misturar clientes numa VPS mistura número, marca e risco |
| **Projeto Supabase** | do cliente — token **dele**, ou ele cria o projeto e manda as 4 credenciais | o token é chave mestra da conta; o plano grátis permite **2 projetos por usuário** — a agência não hospeda N clientes numa conta |
| **Chave de IA** | do cliente (conta dele no provedor) | é ele quem paga o consumo, e dá para trocar pela tela depois |
| **Domínio** | do cliente (`crm.clientedele.com.br`), com o registro A criado no painel dele | marca própria e independência da agência |
| **E-mail do dono (`OWNER_EMAIL`)** | do cliente | é o primeiro admin; a agência entra depois por convite, como membro |
| **Resend** (e-mails) | conta e domínio verificado do cliente, ou da agência se ela opera os envios | o remetente precisa ser de domínio verificado |

Se a agência opera vários clientes, o modelo suportado é **uma instalação por cliente** (VPS +
Supabase + domínio próprios). Várias organizações numa instalação só existe para quem administra a
plataforma inteira — ver `docs/white-label.md`.

## A marca do cliente, sem tocar em código

- `APP_NAME` e `APP_ACCENT_HEX` na instalação são só a **semente**. Nome, cor e logo vivem na tela
  **Configurações › Marca** — e ficam quando o CRM atualiza.
- Nunca edite constante de marca no código nem títulos das telas: a marca some no próximo update e,
  se virar PR, entra em silêncio para todas as instalações do mundo (já aconteceu: PR #465).
- E-mails de acesso com a marca e o link certo: `export SUPABASE_ACCESS_TOKEN=sbp_... && bash hostgator-setup-kit/marca-emails.sh`
  (token do cliente).
- `SUPPORT_EMAIL`: o endereço que os **usuários do cliente** veem — o da agência, se ela dá suporte.
- O PDF de LGPD **não** leva marca: nomeia o controlador (a empresa do cliente) e o DPO. É lei, não
  omissão.

## Entrega que a agência faz no fim

1. `bash hostgator-setup-kit/healthcheck.sh` verde.
2. Backup diário agendado no cron e explicado ao cliente (os arquivos ficam na VPS dele).
3. Dono logado, WhatsApp conectado pelo onboarding, verificação em duas etapas ligada **se o
   cliente quiser** (Configurações › Segurança).
4. O cliente sabe que atualiza pela tela (menu → rodapé → "Nova versão").
5. Senhas e tokens entregues ao cliente por canal seguro — e apagados da máquina da agência.

Montar os agentes de IA, roteadores, follow-ups e base de conhecimento para o nicho do cliente é o
passo seguinte: guia `deskcomm-cliente-novo`.
