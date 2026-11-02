import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  parse: vi.fn(),
  imapOptions: [] as Record<string, unknown>[],
  locks: [] as { mailbox: string; options: Record<string, unknown> }[],
  uidValidity: 17,
  uidNext: 9,
  searchUids: [6, 7, 8] as number[],
  sizes: new Map<number, number>(),
  imapConnectError: null as Error | null,
  imapLockError: null as Error | null,
  released: 0,
  loggedOut: 0,
  closed: 0,
  searched: [] as unknown[],
  fetched: [] as { uids: number[]; query: Record<string, unknown> }[],
  transport: null as null | {
    verify: ReturnType<typeof vi.fn>;
    sendMail: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("imapflow", () => ({
  ImapFlow: class FakeImapFlow {
    mailbox = { uidValidity: BigInt(mocks.uidValidity), uidNext: mocks.uidNext };

    constructor(options: Record<string, unknown>) {
      mocks.imapOptions.push(options);
    }

    on() {
      return this;
    }

    async connect() {
      if (mocks.imapConnectError) throw mocks.imapConnectError;
    }

    async getMailboxLock(mailbox: string, options: Record<string, unknown>) {
      mocks.locks.push({ mailbox, options });
      if (mocks.imapLockError) throw mocks.imapLockError;
      return { release: () => { mocks.released += 1; } };
    }

    async search(query: unknown) {
      mocks.searched.push(query);
      return mocks.searchUids;
    }

    async fetchAll(uids: number[], query: Record<string, unknown>) {
      mocks.fetched.push({ uids, query });
      if ("size" in query) {
        return uids.map((uid) => ({
          uid,
          size: mocks.sizes.get(uid) ?? 100,
          internalDate: new Date("2026-11-02T12:00:00.000Z"),
          envelope: {
            messageId: `<msg-${uid}@example.test>`,
            inReplyTo: null,
            from: [{ address: "cliente@example.test", name: "Cliente" }],
            subject: "Olá",
          },
        }));
      }
      return uids.map((uid) => ({ uid, source: new Uint8Array([uid]) }));
    }

    async logout() {
      mocks.loggedOut += 1;
    }

    close() {
      mocks.closed += 1;
    }
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

vi.mock("postal-mime", () => ({
  default: { parse: mocks.parse },
}));

import {
  checkHostingerEmailAccess,
  createHostingerInboxCursor,
  readHostingerInboxPage,
  sendHostingerEmail,
} from "./hostinger";

const CREDENTIALS = { email: "contato@dreamlab.lol", password: "example-secret" };

describe("canal Hostinger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.imapOptions.length = 0;
    mocks.locks.length = 0;
    mocks.searched.length = 0;
    mocks.fetched.length = 0;
    mocks.sizes.clear();
    mocks.uidValidity = 17;
    mocks.uidNext = 9;
    mocks.searchUids = [6, 7, 8];
    mocks.imapConnectError = null;
    mocks.imapLockError = null;
    mocks.released = 0;
    mocks.loggedOut = 0;
    mocks.closed = 0;
    mocks.transport = {
      verify: vi.fn().mockResolvedValue(undefined),
      sendMail: vi.fn().mockResolvedValue({ messageId: "<sent@example.test>" }),
      close: vi.fn(),
    };
    mocks.createTransport.mockReturnValue(mocks.transport);
    mocks.parse.mockResolvedValue({
      messageId: "<inbound@example.test>",
      inReplyTo: "<sent@example.test>",
      references: "<root@example.test> <sent@example.test>",
      from: { address: "cliente@example.test", name: "Cliente" },
      subject: "Olá",
      text: "Pedido enviado por e-mail.",
      html: "<p>Este HTML não deve ser usado.</p>",
      attachments: [{ filename: "dados.txt" }],
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("verifica IMAP e SMTP com TLS sem ler mensagens nem enviar e-mail", async () => {
    const access = await checkHostingerEmailAccess(CREDENTIALS);

    expect(access).toEqual({
      provider: "hostinger",
      incoming: "connected",
      outgoing: "connected",
      ready: true,
    });
    expect(mocks.imapOptions[0]).toMatchObject({
      host: "imap.hostinger.com",
      port: 993,
      secure: true,
      auth: { user: CREDENTIALS.email, pass: CREDENTIALS.password },
      logger: false,
    });
    expect(mocks.locks[0]).toMatchObject({ mailbox: "INBOX", options: { readOnly: true } });
    expect(mocks.transport?.verify).toHaveBeenCalledOnce();
    expect(mocks.transport?.sendMail).not.toHaveBeenCalled();
    expect(mocks.transport?.close).toHaveBeenCalledOnce();
    expect(mocks.released).toBe(1);
    expect(mocks.loggedOut).toBe(1);
  });

  it("sanitiza o estado de autenticação recusada", async () => {
    mocks.imapConnectError = Object.assign(new Error("detail with mailbox"), {
      code: "AUTHENTICATIONFAILED",
    });
    mocks.transport?.verify.mockRejectedValueOnce(Object.assign(new Error("secret response"), {
      responseCode: 535,
    }));

    const access = await checkHostingerEmailAccess(CREDENTIALS);

    expect(access.incoming).toBe("authentication_failed");
    expect(access.outgoing).toBe("authentication_failed");
    expect(access.ready).toBe(false);
  });

  it("envia com cabeçalhos RFC validados e devolve apenas o Message-ID", async () => {
    const result = await sendHostingerEmail(CREDENTIALS, {
      to: "cliente@example.test",
      subject: "Re: Olá",
      text: "Resposta",
      html: "<p>Resposta</p>",
      inReplyTo: "<root@example.test>",
      references: ["<root@example.test>", "<sent@example.test>"],
    });

    expect(result).toEqual({ ok: true, id: "<sent@example.test>" });
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.hostinger.com",
      port: 465,
      secure: true,
      auth: { user: CREDENTIALS.email, pass: CREDENTIALS.password },
    }));
    expect(mocks.transport?.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "cliente@example.test",
      inReplyTo: "<root@example.test>",
      references: ["<root@example.test>", "<sent@example.test>"],
    }));
  });

  it("não envia cabeçalhos de fio inválidos e transforma erro SMTP em código sanitizado", async () => {
    const invalid = await sendHostingerEmail(CREDENTIALS, {
      to: "cliente@example.test",
      subject: "Teste",
      html: "<p>Teste</p>",
      messageId: "<injetado\r\nBcc: vitima@example.test>",
    });
    expect(invalid).toEqual({ ok: false, error: "send_failed", details: "invalid_thread_headers" });
    expect(mocks.transport?.sendMail).not.toHaveBeenCalled();

    mocks.transport?.sendMail.mockRejectedValueOnce(Object.assign(
      new Error("mailbox recipient@example.test details"),
      { responseCode: 550 },
    ));
    const rejected = await sendHostingerEmail(CREDENTIALS, {
      to: "cliente@example.test",
      subject: "Teste",
      html: "<p>Teste</p>",
    });
    expect(rejected).toEqual({ ok: false, error: "sender_rejected", details: "smtp_response_550" });
    expect(JSON.stringify(rejected)).not.toContain("recipient@example.test");
  });

  it("inicia no UID mais recente e importa somente texto simples de uma página limitada", async () => {
    await expect(createHostingerInboxCursor(CREDENTIALS)).resolves.toEqual({
      uidValidity: "17",
      lastUid: 8,
    });

    mocks.sizes.set(7, 1_000_001);
    const page = await readHostingerInboxPage(
      CREDENTIALS,
      { uidValidity: "17", lastUid: 5 },
      { limit: 999 },
    );

    expect(page.state).toBe("ready");
    if (page.state !== "ready") return;
    expect(page.messages).toHaveLength(3);
    expect(page.messages[0]).toMatchObject({
      uid: 6,
      untrusted: true,
      from: "cliente@example.test",
      text: "Pedido enviado por e-mail.",
      contentState: "available",
    });
    expect(page.messages[1]).toMatchObject({ uid: 7, text: "", contentState: "too_large" });
    expect(page.proposedCursor).toEqual({ uidValidity: "17", lastUid: 8 });
    expect(mocks.searched[0]).toEqual({ uid: "6:*" });
    expect(mocks.fetched.some(({ query }) => "source" in query)).toBe(true);
    expect(mocks.locks.every(({ options }) => options.readOnly === true)).toBe(true);
    expect(mocks.released).toBe(2);
    expect(mocks.loggedOut).toBe(2);
  });

  it("não reimporta histórico quando o UIDVALIDITY da caixa muda", async () => {
    const page = await readHostingerInboxPage(CREDENTIALS, {
      uidValidity: "16",
      lastUid: 100,
    });

    expect(page).toMatchObject({ state: "uid_validity_changed", observedUidValidity: "17" });
    expect(mocks.searched).toHaveLength(0);
  });
});
