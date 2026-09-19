import { TRPCError } from "@trpc/server";

type StateMap = Record<string, readonly string[]>;

const transitions: Record<string, StateMap> = {
  company: {
    new: ["researched", "not_fit", "suppressed"],
    researched: ["qualified", "contact_permission_unknown", "not_fit", "suppressed"],
    contact_permission_unknown: ["contacted", "suppressed"],
    qualified: ["contacted", "proposal_pending", "not_fit", "suppressed"],
    contacted: ["replied", "not_fit", "suppressed"],
    replied: ["discovery", "not_fit", "suppressed"],
    discovery: ["proposal_pending", "not_fit", "suppressed"],
    proposal_pending: ["converted", "not_fit", "suppressed"],
    converted: ["active", "suspended", "closed"],
    active: ["suspended", "closed"],
    suspended: ["active", "closed"],
  },
  job: {
    draft: ["needs_information", "client_confirmation", "cancelled"],
    needs_information: ["draft", "client_confirmation", "cancelled"],
    client_confirmation: ["approved", "needs_information", "cancelled"],
    approved: ["sourcing", "paused", "cancelled"],
    sourcing: ["screening", "shortlist_ready", "paused", "cancelled"],
    screening: ["shortlist_ready", "paused", "cancelled"],
    shortlist_ready: ["interviewing", "sourcing", "paused", "cancelled"],
    interviewing: ["offer_stage", "sourcing", "paused", "cancelled"],
    offer_stage: ["filled", "interviewing", "cancelled"],
    filled: ["archived"],
    paused: ["sourcing", "cancelled"],
    cancelled: ["archived"],
  },
  // Candidate lifecycle state machine.
  // Note: To support statutory GDPR & DPDP right to erasure (data deletion requests),
  // "deleted" reachability is explicitly enabled from all candidate states. When fulfilled,
  // the erasure cascades to close all connected active interviews, shortlists, matches, and placements.
  candidate: {
    imported: ["consent_pending", "consented", "profile_incomplete", "do_not_contact", "deleted"],
    consent_pending: ["consented", "do_not_contact", "deleted"],
    consented: ["available", "profile_incomplete", "withdrawn", "do_not_contact", "deleted"],
    profile_incomplete: ["consented", "available", "withdrawn", "deleted"],
    available: ["outreach_queued", "interested", "screening", "do_not_contact", "withdrawn", "deleted"],
    outreach_queued: ["interested", "available", "do_not_contact", "withdrawn", "deleted"],
    interested: ["screening", "qualified", "withdrawn", "do_not_contact", "deleted"],
    screening: ["qualified", "available", "withdrawn", "do_not_contact", "deleted"],
    qualified: ["shortlisted", "submitted", "available", "withdrawn", "deleted"],
    shortlisted: ["submitted", "interview", "available", "withdrawn", "deleted"],
    submitted: ["interview", "offer", "available", "withdrawn", "deleted"],
    interview: ["offer", "available", "withdrawn", "deleted"],
    offer: ["joined", "available", "withdrawn", "deleted"],
    joined: ["withdrawn", "deleted"],
    withdrawn: ["deletion_pending", "deleted"],
    do_not_contact: ["deletion_pending", "deleted"],
    deletion_pending: ["deleted"],
    deleted: [],
  },
  interview: {
    proposed: ["availability_requested", "scheduled", "cancelled"],
    availability_requested: ["scheduled", "cancelled"],
    scheduled: ["confirmed", "reschedule_requested", "cancelled", "no_show"],
    confirmed: ["reminder_sent", "completed", "reschedule_requested", "cancelled", "no_show"],
    reminder_sent: ["completed", "reschedule_requested", "cancelled", "no_show"],
    reschedule_requested: ["scheduled", "cancelled"],
    completed: ["feedback_pending", "closed"],
    feedback_pending: ["feedback_received", "closed"],
    feedback_received: ["closed"],
    no_show: ["reschedule_requested", "closed"],
    cancelled: [],
    closed: [],
  },
  screening: {
    not_started: ["in_progress", "closed"],
    in_progress: ["evidence_pending", "ready_for_owner_decision", "closed"],
    evidence_pending: ["in_progress", "ready_for_owner_decision", "closed"],
    ready_for_owner_decision: ["decision_pending", "closed"],
    decision_pending: ["owner_decided", "closed"],
    owner_decided: ["closed"],
    closed: [],
  },
  shortlist: {
    prepared: ["approval_pending", "withdrawn", "expired"],
    approval_pending: ["shared", "prepared", "withdrawn"],
    shared: ["viewed", "withdrawn", "expired"],
    viewed: ["withdrawn", "expired"],
    withdrawn: [],
    expired: [],
  },
  match: {
    candidate_found: ["low_confidence", "evidence_validated", "withdrawn", "closed"],
    low_confidence: ["evidence_validated", "withdrawn", "closed"],
    evidence_validated: ["shortlisted", "withdrawn", "closed"],
    shortlisted: ["withdrawn", "closed"],
    withdrawn: ["closed"],
    closed: [],
  },
  automation_job: {
    queued: ["running", "blocked", "cancelled"],
    running: ["completed", "retryable_failed", "permanently_failed", "blocked"],
    retryable_failed: ["queued", "permanently_failed", "blocked", "cancelled"],
    blocked: ["queued", "cancelled"],
  },
  rights_request: {
    received: ["acknowledged", "investigation", "resolved", "rejected"],
    acknowledged: ["investigation", "resolved", "rejected"],
    investigation: ["resolved", "rejected"],
    resolved: [],
    rejected: [],
  },
  incident: {
    detected: ["triaged", "contained", "resolved"],
    triaged: ["contained", "investigated", "resolved"],
    contained: ["investigated", "resolved"],
    investigated: ["resolved"],
    resolved: [],
  },
  placement: {
    offer_pending: ["offer_issued", "closed"],
    offer_issued: ["offer_accepted", "closed"],
    offer_accepted: ["joining_pending", "closed"],
    joining_pending: ["joining_confirmed", "closed"],
    joining_confirmed: ["invoice_eligible", "guarantee_active", "closed"],
    invoice_eligible: ["guarantee_active", "closed"],
    guarantee_active: ["guarantee_ended", "replacement_requested", "closed"],
    replacement_requested: ["replacement_in_progress", "closed"],
    replacement_in_progress: ["replacement_closed", "closed"],
    replacement_closed: ["closed"],
    guarantee_ended: ["closed"],
    closed: [],
  },
  invoice: {
    draft: ["validation", "approval_pending", "cancelled"],
    validation: ["approval_pending", "draft", "cancelled"],
    approval_pending: ["issued", "draft", "cancelled"],
    issued: ["delivered", "payment_pending", "disputed"],
    delivered: ["payment_pending", "partially_paid", "paid", "overdue", "disputed"],
    payment_pending: ["partially_paid", "paid", "overdue", "disputed"],
    partially_paid: ["paid", "overdue", "disputed"],
    overdue: ["partially_paid", "paid", "disputed", "credited", "written_off"],
    disputed: ["payment_pending", "credited", "written_off", "closed"],
    credited: ["closed"],
    written_off: ["closed"],
    paid: ["closed"],
    closed: [],
    cancelled: [],
  },
};

export function assertTransition(resource: keyof typeof transitions, from: string, to: string) {
  if (from === to) return;
  const allowed = transitions[resource][from] ?? [];
  if (!allowed.includes(to)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${resource} transition: ${from} → ${to}`,
    });
  }
}

export function isConsequentialAction(actionType: string) {
  return new Set([
    "client_onboarding",
    "candidate_share",
    "final_candidate_decision",
    "candidate_final_decision",
    "placement_confirmation",
    "replacement_case",
    "invoice_issue",
    "invoice_payment_status",
    "invoice_dispute",
    "invoice_credit",
    "invoice_write_off",
    "automation_stop",
  ]).has(actionType);
}

export const SENSITIVE_TERMS = [
  "caste",
  "religion",
  "marital status",
  "pregnant",
  "disability",
  "age preference",
  "facial emotion",
  "personality score",
  "accent score",
];

export function ensureSafeAiText(value: string) {
  const lowered = value.toLowerCase();
  if (SENSITIVE_TERMS.some(term => lowered.includes(term))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The requested AI action contains a protected or prohibited recruitment signal.",
    });
  }
}

export const WORKFLOW_STATES = transitions;
