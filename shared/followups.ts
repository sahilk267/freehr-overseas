export const FOLLOW_UP_SCENARIOS = [
  ["FU01", "Prospect outreach", "clients"], ["FU02", "Discovery availability", "clients"],
  ["FU03", "Discovery clarification", "clients"], ["FU04", "Proposal review", "clients"],
  ["FU05", "Agreement signature", "clients"], ["FU06", "Missing job requirements", "clients"],
  ["FU07", "Requirement confirmation", "clients"], ["FU08", "Candidate consent", "talent"],
  ["FU09", "Candidate interest", "talent"], ["FU10", "Missing candidate evidence", "talent"],
  ["FU11", "Screening completion", "talent"], ["FU12", "Assessment completion", "talent"],
  ["FU13", "Candidate clarification", "talent"], ["FU14", "Client-sharing permission", "talent"],
  ["FU15", "Submission review", "clients"], ["FU16", "Client feedback", "clients"],
  ["FU17", "Interview availability", "interviews"], ["FU18", "Interview reminder", "interviews"],
  ["FU19", "No-show or reschedule", "interviews"], ["FU20", "Interviewer feedback", "interviews"],
  ["FU21", "Offer response", "talent"], ["FU22", "Prejoining milestone", "talent"],
  ["FU23", "Joining confirmation", "talent"], ["FU24", "Retention check-in", "talent"],
  ["FU25", "Replacement progress", "clients"], ["FU26", "Invoice collection", "finance"],
  ["FU27", "Promise to pay", "finance"], ["FU28", "Repeat hiring and referrals", "clients"],
  ["FU29", "Talent availability refresh", "talent"], ["FU30", "Rights request acknowledgement", "privacy"],
  ["FU31", "Verification response", "talent"], ["FU32", "Relocation milestone", "talent"],
] as const;

export type FollowUpScenario = typeof FOLLOW_UP_SCENARIOS[number][0];
export type FollowUpStep = { delayMinutes: number; subject: string; body: string };
export type FollowUpResource = "conversation" | "interview" | "invoice";
export const ACTIVE_FOLLOW_UP_STATES = ["scheduled", "waiting", "approval_pending", "paused", "blocked"] as const;
