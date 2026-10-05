import {
  AccountApi,
  Configuration,
  MessagesApi,
  SendApi,
  type V1FolderMessagesMessage,
  type V1FolderMessagesSearchRequest,
  type V1SendMessageRef,
  type V1SendRequest,
} from "hostinger-mail-api-sdk";

export const EMAIL_PURPOSES = ["owner", "clients", "talent", "interviews", "finance", "privacy"] as const;
export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];

const approvedDomain = (process.env.HOSTINGER_MAIL_FROM_DOMAIN || "overseasjob.in").trim().toLowerCase();
export const CANONICAL_MAILBOX_ENV_KEYS: Record<EmailPurpose, string> = {
  owner: "OWNER_MAILBOX",
  clients: "CLIENTS_MAILBOX",
  talent: "TALENT_MAILBOX",
  interviews: "INTERVIEWS_MAILBOX",
  finance: "FINANCE_MAILBOX",
  privacy: "PRIVACY_MAILBOX",
};
const mailboxResourceEnvKey: Record<EmailPurpose, string> = {
  owner: "HOSTINGER_MAILBOX_OWNER_ID",
  clients: "HOSTINGER_MAILBOX_CLIENTS_ID",
  talent: "HOSTINGER_MAILBOX_TALENT_ID",
  interviews: "HOSTINGER_MAILBOX_INTERVIEWS_ID",
  finance: "HOSTINGER_MAILBOX_FINANCE_ID",
  privacy: "HOSTINGER_MAILBOX_PRIVACY_ID",
};
const senderAddressEnvKey: Record<EmailPurpose, string> = {
  owner: "HOSTINGER_MAILBOX_OWNER_ADDRESS",
  clients: "HOSTINGER_MAILBOX_CLIENTS_ADDRESS",
  talent: "HOSTINGER_MAILBOX_TALENT_ADDRESS",
  interviews: "HOSTINGER_MAILBOX_INTERVIEWS_ADDRESS",
  finance: "HOSTINGER_MAILBOX_FINANCE_ADDRESS",
  privacy: "HOSTINGER_MAILBOX_PRIVACY_ADDRESS",
};

export function isApprovedSenderAddress(address: string) {
  const normalized = address.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.endsWith(`@${approvedDomain}`);
}

export function getSenderAddress(purpose: EmailPurpose) {
  const configured =
    process.env[CANONICAL_MAILBOX_ENV_KEYS[purpose]]?.trim().toLowerCase() ||
    process.env[senderAddressEnvKey[purpose]]?.trim().toLowerCase();
  return configured || `${purpose}.fl@${approvedDomain}`;
}

export function detectOptOut(text: string) {
  return /\b(stop|unsubscribe|do not contact|remove me|don't contact|dont contact)\b/i.test(text);
}

export function normalizeMessageRef(ref?: string | null): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^<+/, "").replace(/>+$/, "");
}

export function chooseThreadReference(input: { inReplyTo?: string; references: string[] }) {
  return input.inReplyTo?.trim() || input.references.find(Boolean)?.trim() || null;
}

export function getHostingerMailApiStatus() {
  const token = process.env.HOSTINGER_MAIL_API_TOKEN?.trim();
  return {
    configured: Boolean(token),
    tokenConfigured: Boolean(token),
    webhookSecretConfigured: Boolean(process.env.HOSTINGER_MAIL_WEBHOOK_SECRET?.trim()),
    configuredMailboxCount: Object.values(mailboxResourceEnvKey).filter(key => Boolean(process.env[key]?.trim())).length,
    configuredSenderAddressCount: EMAIL_PURPOSES.filter(purpose => isApprovedSenderAddress(getSenderAddress(purpose))).length,
  };
}

function getClient() {
  const token = process.env.HOSTINGER_MAIL_API_TOKEN?.trim();
  if (!token) throw new Error("Hostinger Mail API token is not configured.");
  return new Configuration({ accessToken: token });
}

export async function verifyHostingerMailApi() {
  if (!getHostingerMailApiStatus().configured) return { ok: false, status: "credentials_missing" as const };
  try {
    await new AccountApi(getClient()).getCurrentAccount();
    return { ok: true, status: "verified" as const };
  } catch {
    return { ok: false, status: "connection_failed" as const };
  }
}

export interface ResolveSentMessageInput {
  mailboxResourceId: string;
  to: string;
  subject: string;
  sentAt?: Date;
  folder?: string;
}

export interface ResolveSentMessageResult {
  providerUid: number | null;
  providerFolder: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  isAmbiguous: boolean;
}

export async function resolveSentMessageInHostinger(
  input: ResolveSentMessageInput
): Promise<ResolveSentMessageResult> {
  const foldersToTry = input.folder ? [input.folder] : ["INBOX.Sent", "Sent"];
  const messagesApi = new MessagesApi(getClient());

  for (const folder of foldersToTry) {
    try {
      const searchPayload: V1FolderMessagesSearchRequest = {
        since: "",
        before: "",
        flags: [],
        uid: "",
        subject: input.subject,
        from: "",
        to: input.to,
        cc: "",
        body: "",
        header: "",
        larger: 0,
        smaller: 0,
        text: "",
      };

      const searchRes = await messagesApi.searchMessages(
        input.mailboxResourceId,
        folder,
        1,
        20,
        "-date",
        searchPayload
      );

      const items = searchRes.data?.data;
      if (!Array.isArray(items) || items.length === 0) {
        continue;
      }

      // Strictly filter to exact recipient and subject match
      const targetTo = input.to.trim().toLowerCase();
      const targetSubject = input.subject.trim().toLowerCase();

      const matched = items.filter((msg: V1FolderMessagesMessage) => {
        const msgSubject = (msg.subject ?? "").trim().toLowerCase();
        if (msgSubject !== targetSubject) return false;

        const hasRecipient =
          Array.isArray(msg.to) &&
          msg.to.some(recipient => recipient.address?.trim().toLowerCase() === targetTo);
        if (!hasRecipient) return false;

        if (input.sentAt && msg.date) {
          const msgDate = new Date(msg.date).getTime();
          // Filter within 10-minute window
          const diffMs = Math.abs(msgDate - input.sentAt.getTime());
          if (diffMs > 10 * 60 * 1000) return false;
        }

        return true;
      });

      if (matched.length === 1) {
        const item = matched[0];
        return {
          providerUid: typeof item.uid === "number" ? item.uid : null,
          providerFolder: item.path || folder,
          messageId: item.messageId ?? null,
          inReplyTo: item.inReplyTo ?? null,
          isAmbiguous: false,
        };
      }

      if (matched.length > 1) {
        // Ambiguous match across multiple messages: fail safe without arbitrary guessing
        return {
          providerUid: null,
          providerFolder: null,
          messageId: null,
          inReplyTo: null,
          isAmbiguous: true,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    providerUid: null,
    providerFolder: null,
    messageId: null,
    inReplyTo: null,
    isAmbiguous: false,
  };
}

export interface SendHostingerMailInput {
  purpose: EmailPurpose;
  to: string;
  displayName: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string | V1SendMessageRef | { uid?: number | null; folder?: string | null };
  references?: string[];
}

export interface SendHostingerMailResult {
  providerMessageId: string | null;
  providerUid: number | null;
  providerFolder: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  senderAddress: string;
  mailboxResourceId: string;
}

export async function sendViaHostingerMailApi(
  input: SendHostingerMailInput
): Promise<SendHostingerMailResult> {
  const senderAddress = getSenderAddress(input.purpose);
  if (!isApprovedSenderAddress(senderAddress)) {
    throw new Error("Selected sender is not in the approved domain allowlist.");
  }
  const mailboxResourceId = process.env[mailboxResourceEnvKey[input.purpose]]?.trim();
  if (!mailboxResourceId) {
    throw new Error(`Hostinger mailbox resource ID is not configured for ${input.purpose}.`);
  }

  // Parse inReplyTo strictly using Hostinger V1SendMessageRef ({ uid: number, folder: string })
  let sendInReplyTo: V1SendMessageRef | undefined = undefined;
  if (input.inReplyTo) {
    if (
      typeof input.inReplyTo === "object" &&
      typeof input.inReplyTo.uid === "number" &&
      input.inReplyTo.uid > 0
    ) {
      sendInReplyTo = {
        uid: input.inReplyTo.uid,
        folder: input.inReplyTo.folder || "INBOX",
      };
    } else if (typeof input.inReplyTo === "string" && /^\d+$/.test(input.inReplyTo.trim())) {
      const parsedUid = parseInt(input.inReplyTo.trim(), 10);
      if (parsedUid > 0) {
        sendInReplyTo = {
          uid: parsedUid,
          folder: "INBOX",
        };
      }
    }
    // If not a valid numeric UID: do NOT invent one. Safe non-threaded send.
  }

  // Construct request payload using only real SDK fields
  const payload: Partial<V1SendRequest> = {
    to: [input.to],
    displayName: input.displayName,
    cc: [],
    bcc: [],
    subject: input.subject,
    text: input.text,
    html: input.html || "",
    attachments: [],
  };

  if (sendInReplyTo) {
    payload.inReplyTo = sendInReplyTo;
  }

  const sentTime = new Date();
  let response: any = null;
  try {
    response = await new SendApi(getClient()).sendEmail(
      mailboxResourceId,
      payload as V1SendRequest
    );
  } catch (error) {
    throw error;
  }

  // Check if explicit provider message ID is present in response data/headers (e.g. test mocks)
  const rawApiId =
    response?.data?.messageId ??
    response?.data?.id ??
    response?.headers?.["message-id"] ??
    response?.headers?.["x-message-id"] ??
    null;

  let providerMessageId: string | null =
    typeof rawApiId === "string" && rawApiId.trim() ? rawApiId.trim() : null;

  let providerUid: number | null = null;
  let providerFolder: string | null = null;
  let rfcMessageId: string | null = providerMessageId;
  let rfcInReplyTo: string | null = null;

  // If send endpoint did not return an explicit message ID (standard Hostinger 204 response),
  // resolve the sent message from the Sent folder
  if (!providerMessageId) {
    try {
      const resolved = await resolveSentMessageInHostinger({
        mailboxResourceId,
        to: input.to,
        subject: input.subject,
        sentAt: sentTime,
      });

      if (!resolved.isAmbiguous && resolved.providerUid != null) {
        providerUid = resolved.providerUid;
        providerFolder = resolved.providerFolder;
        if (resolved.messageId) {
          rfcMessageId = resolved.messageId;
        }
        rfcInReplyTo = resolved.inReplyTo;
      }
    } catch {
      // Resolution error: fail safely without fabricating an ID
    }
  }

  return {
    providerMessageId,
    providerUid,
    providerFolder,
    messageId: rfcMessageId,
    inReplyTo: rfcInReplyTo,
    senderAddress,
    mailboxResourceId,
  };
}
