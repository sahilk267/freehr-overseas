# FreelanceHR Team Access Controls

## Purpose

FreelanceHR supports **owner-controlled, least-privilege** team membership for operational preparation and visibility. The owner is the only role that can administer memberships, approve consequential actions, initiate client sharing, issue commercial outcomes, operate email delivery controls, or change policies and automation boundaries.

## Invitation lifecycle

| Stage | System behavior | Security control |
| --- | --- | --- |
| Create | The owner selects an email, role, and expiry. | The stored invitation contains a SHA-256 token hash, never the raw code. |
| Share | The owner receives the raw one-time code once in the Team & access workspace. | Until Hostinger Mail API activation is verified, the code must be shared manually through an approved secure channel. |
| Activate | A signed-in user submits the code. | The signed-in email must exactly match the invited email, and expired, revoked, or reused codes are rejected. |
| Use | The browser selects the activated workspace through a scoped request header. | The server validates active membership on every protected request and rejects unavailable routes. |
| Revoke | The owner revokes the membership. | Active membership is disabled and pending invitations for that member are invalidated. |

## Role matrix

| Role | Permitted workspace routes | Non-delegable owner controls |
| --- | --- | --- |
| Recruiter | Recruitment preparation, sourced records, job and candidate preparation, screening evidence, controlled outreach drafts | Consent/withdrawal/DNC, candidate sharing, final decisions, client onboarding, email delivery, finance changes |
| Coordinator | Interview scheduling, interview state coordination, feedback capture, interview-reminder drafts | All approvals, client/candidate external communication, privacy actions, finance actions |
| Finance | Placement and invoice visibility; invoice draft preparation | Invoice issuance, payment/dispute/credit final state, email delivery, approvals |
| Viewer | Read-only operational visibility | All changes, all approvals, all sensitive privacy and sending controls |
| Owner | Full private workspace control | Not delegable through the team invitation interface |

## Audit evidence

Invitation creation, invitation acceptance, role updates, and revocations create audit events. For actions performed through an activated member workspace, user-attributed audit records preserve the acting account and add the member role and workspace owner context to metadata. This makes delegated preparation distinguishable from owner decisions.

## Production restriction

The current development login uses the existing project authentication integration. Before deploying to Hostinger, replace that integration with a production OIDC/session implementation and preserve the same active-workspace resolution rules. Do not treat successful local activation as a production access-control test until the OIDC identity, session cookies, database migration, and role-denial paths have been tested on the deployed domain.
