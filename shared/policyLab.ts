import { z } from "zod";
export const POLICY_LAB_VERSION = "policy-lab-v1";
export const policySimulation = z
  .object({
    policySource: z.enum(["current", "saved", "what_if"]),
    policyId: z.string().min(4).max(64).optional(),
    configJson: z.string().min(2).max(64000).optional(),
    subject: z.enum(["hypothetical", "approval"]),
    actionType: z.string().trim().min(1).max(80).optional(),
    payloadJson: z.string().max(32000).optional(),
    approvalId: z.string().min(4).max(64).optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.policySource === "saved" && !v.policyId)
      c.addIssue({
        code: "custom",
        path: ["policyId"],
        message: "Choose an owned saved policy.",
      });
    if (v.policySource !== "saved" && v.policyId !== undefined)
      c.addIssue({
        code: "custom",
        path: ["policyId"],
        message: "Saved policy IDs apply only to saved-policy simulation.",
      });
    if (v.policySource === "what_if" && !v.configJson)
      c.addIssue({
        code: "custom",
        path: ["configJson"],
        message: "Enter an unsaved policy configuration.",
      });
    if (v.policySource !== "what_if" && v.configJson !== undefined)
      c.addIssue({
        code: "custom",
        path: ["configJson"],
        message:
          "Configuration overrides apply only to unsaved what-if simulation.",
      });
    if (
      v.subject === "approval" &&
      (!v.approvalId ||
        v.actionType !== undefined ||
        v.payloadJson !== undefined)
    )
      c.addIssue({
        code: "custom",
        path: ["approvalId"],
        message:
          "Stored approval inspection requires its owned ID without action or payload overrides.",
      });
    if (
      v.subject === "hypothetical" &&
      (!v.actionType || v.approvalId !== undefined)
    )
      c.addIssue({
        code: "custom",
        path: ["actionType"],
        message:
          "Hypothetical simulation requires an action without a stored approval ID.",
      });
  });
export const policyLabQuery = z
  .object({
    status: z
      .enum(["all", "pending", "approved", "rejected", "cancelled"])
      .default("pending"),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
  .default({ status: "pending", offset: 0, limit: 25 });
