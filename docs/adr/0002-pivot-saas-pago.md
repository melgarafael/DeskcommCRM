# ADR-0002 — Pivot para SaaS pago (Genesisia Contabilidade), sem abandonar o self-host

- **Status:** aceito
- **Data:** 2026-08-22
- **Lei decorrente:** este documento (não há doutrina separada — a regra cabe inteira aqui)

---

## Contexto

Até esta decisão, o `VISION.md` afirmava, na seção "Modelo do projeto (sem letra miúda)":
"O software é 100% open source (MIT), completo, sem versão paga. Não vendemos assinatura."
A monetização documentada era exclusivamente a parceria de infraestrutura com a HostGator.

O dono do produto decidiu operar, além do self-host existente, uma instância hospedada e
cobrada por assinatura, sob a marca **Genesisia Contabilidade**, somando módulos de
contabilidade (Contábil/Financeiro) ao CRM de vendas. Isso é uma mudança de modelo de
negócio, não uma feature — e a doutrina anterior proibia explicitamente exatamente isto
("dependência de serviço pago obrigatório quebra o modelo self-host", CLAUDE.md/skill
`DeskcommCRM` §3), então a decisão precisa ficar registrada com o porquê, não só implementada.

## Decisão

**Duas vias coexistem, e a via 1 nunca depende da via 2:**

1. **Self-host MIT.** O código continua idêntico em natureza: quem clona e roda a própria
   VPS (`hostgator-setup-kit`, `docker compose`) nunca paga licença, nunca esbarra em feature
   travada, e o billing **nunca** é pré-requisito de funcionamento — `BILLING_MODE=disabled`
   é o default de `.env.example`, e o código de billing precisa degradar sem quebrar quando
   a flag está desligada (mesma disciplina de `lib/branding/instalacao.ts`, que "nunca lança").
2. **Instância hospedada Genesisia Contabilidade.** Operada pela própria empresa,
   `BILLING_MODE=asaas`, cobrança recorrente via Asaas (Pix/boleto/cartão), branding próprio
   (nome + verde petróleo) via o sistema de white-label já existente
   (`platform_branding`/`organizations.settings.branding`). É **uma oferta**, não uma
   substituição — a instância paga tem módulos a mais (contabilidade), não features do CRM
   de vendas retiradas da via 1.

**O que NÃO foi decidido aqui (e não deveria ter sido, por escopo):** o self-host passar a
cobrar de alguma forma. Essa seria a "Opção B" considerada e rejeitada — exigiria reescrever
`docs/doctrine/packaging.md` inteiro (o `install.sh` passaria a depender de uma chave de API
paga de terceiro só para instalar) e é uma mudança de eixo do produto, não deste pivot.

## Consequências

- `VISION.md`, `CLAUDE.md`, `AGENTS.md`, `README.md` (e traduções, quando existirem)
  descrevem as duas vias — não apenas uma.
- Toda env var nova de billing (`ASAAS_API_KEY`, `ASAAS_ENVIRONMENT`, `BILLING_MODE`) tem
  default que preserva o comportamento atual do self-host (`.env.example` + `lib/env.ts`).
- A matriz RBAC de `docs/specs/13-spec-governanca-atendimento.md` mantém `billing` como
  admin-only — decisão que já era conservadoramente aplicada e agora é explícita: dinheiro
  do tenant é assunto de quem administra a organização, não de agente/manager.
- O plano de landing page do projeto open source (`docs/growth/lp-plano.md`) continua válido
  para `deskcomm.com.br` — a landing da Genesisia Contabilidade é um artefato à parte, dentro
  do monorepo, dirigido pelo resolvedor de branding, nunca herdado por um clone self-host.
- Testes de packaging/self-host (`tests/unit/env-*.test.ts`, `pnpm test:shell`) precisam
  cobrir o caso `BILLING_MODE=disabled` continuando a passar sem nenhuma env var de billing
  presente — é o cenário de todo clone existente.
