# Safe Demo Data Guide

FreelanceHR intentionally does **not** seed production records. Recruitment records contain personal and commercially sensitive information, so all initial workspaces open empty.

For a controlled sandbox demonstration, create the following clearly fictional records through the dashboard and remove them after testing. Alternatively, after the owner has signed in once, run `DEMO_OWNER_OPEN_ID=<owner-open-id> pnpm seed:demo` from a non-production environment. The opt-in script only inserts the three fictional records listed below and does not create any review, rating, testimonial, contact detail, or payment record.

| Record | Safe example | Purpose |
| --- | --- | --- |
| Prospect | `Demo Systems — fictional` | Test CRM stages and owner onboarding approval |
| Contact | `Demo Contact — fictional` | Test an outreach draft without sending it |
| Job | `Demo Backend Engineer — test only` | Test intake quality and scorecard weights |
| Candidate | `Demo Candidate — fictional` | Test consent, document upload, matching, and DNC flows |
| Interview | `Demo interview — test only` | Test status transitions and feedback scorecards |
| Placement | `Demo placement — test only` | Test evidence and approval gates |
| Invoice | `DEMO-DO-NOT-SEND` | Test the invoice approval workflow without payment collection |

Do not use real CVs, actual contact information, customer reviews, ratings, testimonials, payment details, or copied profiles when demonstrating the application. No simulated review, rating, or testimonial is provided by this project.
