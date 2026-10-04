import { AccountApi, Configuration, SendApi } from "hostinger-mail-api-sdk";

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
const mailboxResourceEnvKey: Record<EmailPurpose, string> = { owner: "HOSTINGER_MAILBOX_OWNER_ID", clients: "HOSTINGER_MAILBOX_CLIENTS_ID", talent: "HOSTINGER_MAILBOX_TALENT_ID", interviews: "HOSTINGER_MAILBOX_INTERVIEWS_ID", finance: "HOSTINGER_MAILBOX_FINANCE_ID", privacy: "HOSTINGER_MAILBOX_PRIVACY_ID" };
const senderAddressEnvKey: Record<EmailPurpose, string> = { owner: "HOSTINGER_MAILBOX_OWNER_ADDRESS", clients: "HOSTINGER_MAILBOX_CLIENTS_ADDRESS", talent: "HOSTINGER_MAILBOX_TALENT_ADDRESS", interviews: "HOSTINGER_MAILBOX_INTERVIEWS_ADDRESS", finance: "HOSTINGER_MAILBOX_FINANCE_ADDRESS", privacy: "HOSTINGER_MAILBOX_PRIVACY_ADDRESS" };

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
  return { configured: Boolean(token), tokenConfigured: Boolean(token), webhookSecretConfigured: Boolean(process.env.HOSTINGER_MAIL_WEBHOOK_SECRET?.trim()), configuredMailboxCount: Object.values(mailboxResourceEnvKey).filter(key => Boolean(process.env[key]?.trim())).length, configuredSenderAddressCount: EMAIL_PURPOSES.filter(purpose => isApprovedSenderAddress(getSenderAddress(purpose))).length };
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

export interface SendHostingerMailInput {
  purpose: EmailPurpose;
  to: string;
  displayName: string;
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export async function sendViaHostingerMailApi(input: SendHostingerMailInput) {
  const senderAddress = getSenderAddress(input.purpose);
  if (!isApprovedSenderAddress(senderAddress)) throw new Error("Selected sender is not in the approved domain allowlist.");
  const mailboxResourceId = process.env[mailboxResourceEnvKey[input.purpose]]?.trim();
  if (!mailboxResourceId) throw new Error(`Hostinger mailbox resource ID is not configured for ${input.purpose}.`);

  let response: any = null;
  try {
    response = await new SendApi(getClient()).sendEmail(mailboxResourceId, {
      to: [input.to],
      displayName: input.displayName,
      cc: [],
      bcc: [],
      subject: input.subject,
      text: input.text,
      html: "",
      attachments: [],
      inReplyTo: undefined as never,
      forwardOf: undefined as never,
    });
  } catch (error) {
    throw error;
  }

  // Extract provider message ID if returned by API response/headers, otherwise format deterministic standard Message-ID
  const rawApiId =
    response?.data?.messageId ??
    response?.data?.id ??
    response?.headers?.["message-id"] ??
    response?.headers?.["x-message-id"] ??
    null;

  const deterministicId = input.messageId
    ? `<${input.messageId}@${approvedDomain}>`
    : `<msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}@${approvedDomain}>`;

  const providerMessageId =
    typeof rawApiId === "string" && rawApiId.trim() ? rawApiId.trim() : deterministicId;

  return { providerMessageId, senderAddress, mailboxResourceId };
}
