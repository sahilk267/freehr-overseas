export const CAMPAIGN_SCENARIOS = [
  { id: "FU01", label: "Client acquisition", audience: "contact", purpose: "clients" },
  { id: "FU28", label: "Repeat hiring and referrals", audience: "contact", purpose: "clients" },
  { id: "FU09", label: "Candidate interest", audience: "candidate", purpose: "talent" },
  { id: "FU29", label: "Talent availability refresh", audience: "candidate", purpose: "talent" },
] as const;

export const campaignVariables = ["name", "company", "opt_out"] as const;
export const OPT_OUT_TEXT = "Reply STOP to stop future messages.";

export function renderCampaignText(template: string, values: { name: string; company: string }) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (key === "opt_out") return OPT_OUT_TEXT;
    if (key === "name" || key === "company") return values[key];
    throw new Error(`Unsupported campaign variable: ${key}`);
  });
}
