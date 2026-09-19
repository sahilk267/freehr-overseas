# Hostinger Mail API Activation — FreelanceHR

This guide activates the existing approval-controlled **Hostinger Mail API** layer. Do not place bearer tokens or webhook secrets in source files, client-side code, Git, or chat messages.

## 1. Create and route the mailboxes

Create these six mailboxes in Hostinger Email and forward their inbound mail to the private owner inbox: `owner@overseasjob.in`, `clients@overseasjob.in`, `talent@overseasjob.in`, `interviews@overseasjob.in`, `finance@overseasjob.in`, and `privacy@overseasjob.in`. Each address has a distinct recruitment purpose and is separately visible in FreelanceHR.

## 2. Configure DNS and deliverability

In Hostinger hPanel, publish the SPF and DKIM records generated for the mailbox service. Add a DMARC policy initially using monitoring mode (`p=none`) and review aggregate reports before moving to a stricter policy. Do not enable bulk automation until SPF, DKIM, and DMARC all pass for the sending domain.

## 3. Add the backend-only API credentials

Create an order-scoped Hostinger Mail API token in the Hostinger Panel, restricted to only the intended mailboxes. Then add these values through the secure environment-variable panel:

| Variable | Required value |
| --- | --- |
| `HOSTINGER_MAIL_API_TOKEN` | Order-scoped bearer token created in Hostinger Panel |
| `HOSTINGER_MAIL_FROM_DOMAIN` | `overseasjob.in` |
| `HOSTINGER_MAILBOX_CLIENTS_ID` | Mailbox resource ID for `clients@overseasjob.in` |
| `HOSTINGER_MAILBOX_TALENT_ID` | Mailbox resource ID for `talent@overseasjob.in` |
| `HOSTINGER_MAILBOX_INTERVIEWS_ID` | Mailbox resource ID for `interviews@overseasjob.in` |
| `HOSTINGER_MAILBOX_FINANCE_ID` | Mailbox resource ID for `finance@overseasjob.in` |
| `HOSTINGER_MAILBOX_PRIVACY_ID` | Mailbox resource ID for `privacy@overseasjob.in` |
| `HOSTINGER_MAILBOX_OWNER_ID` | Mailbox resource ID for `owner@overseasjob.in` |
| `HOSTINGER_MAIL_WEBHOOK_SECRET` | Secret used to validate Hostinger inbound webhook events |

For inbound reply monitoring, create a Hostinger Mail API webhook for each permitted mailbox, select the `message.received` event, use `https://freelancehr.overseasjob.in/api/webhooks/hostinger-mail` as the callback URL, and store its one-time bearer token as `HOSTINGER_MAIL_WEBHOOK_SECRET`. No SMTP or IMAP credentials are used by FreelanceHR.

The live readiness indicator in **Control Plane → Domain sender identities** remains disabled until the bearer token is configured. Register each sender identity, map its mailbox resource ID, verify API access, and activate it only after a successful controlled test message.

## 4. Live operating sequence

Every outbound message follows: **draft → owner approval request → owner approval → sender/recipient validation → Hostinger Mail API delivery → audit event**. The delivery layer blocks inactive senders, recipients on the suppression list, and unapproved messages. The emergency stop blocks all external automation.

## 5. Receive replies safely

Configure Hostinger Mail API webhooks for permitted mailboxes and pass every inbound event through the **Inbound mail** adapter. The adapter preserves provider message IDs, maps each reply through `In-Reply-To` or `References`, and routes terms such as “unsubscribe”, “stop”, or “do not contact” to the suppression list before any follow-up is scheduled.

## 6. Activation test

Send exactly one owner-approved message from `clients@overseasjob.in` to an address you control. Confirm the From identity, Reply-To, SPF/DKIM authentication result, thread correlation, audit event, and inbound reply flow. Only then activate controlled client or candidate outreach.
