import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();

export type StoreData = Map<string, Map<string | number, any>>;

function createFilter(expr: any): (item: any) => boolean {
  if (!expr) return () => true;
  try {
    const q = dialect.sqlToQuery(expr);
    const parts = q.sql.split("?");
    let exprJs = "";
    for (let i = 0; i < parts.length - 1; i++) {
      exprJs += parts[i];
      const p = q.params[i];
      if (p && typeof p === "object" && typeof (p as any).name === "string") {
        exprJs += "item." + (p as any).name;
      } else if (p instanceof Date) {
        exprJs += p.getTime();
      } else if (typeof p === "string" && /^\d{4}-\d{2}-\d{2}/.test(p)) {
        exprJs += String(new Date(p).getTime());
      } else {
        exprJs += JSON.stringify(p);
      }
    }
    exprJs += parts[parts.length - 1];

    exprJs = exprJs
      .replace(/`[a-zA-Z0-9_]+`\.`([a-zA-Z0-9_]+)`/g, "item.$1")
      .replace(/`([a-zA-Z0-9_]+)`/g, "item.$1")
      .replace(/date\((item\.[a-zA-Z0-9_]+)\)\s*=\s*curdate\(\)/gi, "true")
      .replace(/(item\.[a-zA-Z0-9_]+)\s*(<=|>=|<|>)\s*(\d{10,})/g, "(item != null && new Date($1).getTime() $2 $3)")
      .replace(/\s+=\s+/g, " === ")
      .replace(/\s+and\s+/gi, " && ")
      .replace(/\s+or\s+/gi, " || ")
      .replace(/\s+is\s+null/gi, " == null")
      .replace(/\s+is\s+not\s+null/gi, " != null")
      .replace(/(item\.[a-zA-Z0-9_]+)\s+not\s+in\s*\(([^)]+)\)/gi, "(![$2].includes($1))")
      .replace(/(item\.[a-zA-Z0-9_]+)\s+in\s*\(([^)]+)\)/gi, "([$2].includes($1))");

    return new Function(
      "item",
      "try { return Boolean(" + exprJs + "); } catch(e) { return true; }"
    ) as (item: any) => boolean;
  } catch (e) {
    return () => true;
  }
}

function getTableMap(store: StoreData, tableName: string) {
  let map = store.get(tableName);
  if (!map) {
    map = new Map();
    store.set(tableName, map);
  }
  return map;
}

export function createMockDrizzle(store: StoreData) {
  const db = {
    async execute(_query?: any) {
      return [{ 1: 1 }];
    },
    select(selection?: any) {
      let currentTable = "";
      const conditions: Array<(item: any) => boolean> = [];
      let sortCol = "";
      let isDesc = false;
      let limitNum = 1000;
      let offsetNum = 0;

      const builder: any = {
        from(table: any) {
          currentTable = getTableName(table);
          return builder;
        },
        where(expr: any) {
          if (expr) conditions.push(createFilter(expr));
          return builder;
        },
        orderBy(...exprs: any[]) {
          for (const expr of exprs) {
            if (!expr) continue;
            try {
              const q = dialect.sqlToQuery(expr);
              if (q.params[0] && typeof (q.params[0] as any).name === "string") {
                sortCol = (q.params[0] as any).name;
                isDesc = /desc/i.test(q.sql);
                break;
              }
            } catch {
              // Ignore
            }
          }
          return builder;
        },
        limit(n: number) {
          limitNum = n;
          return builder;
        },
        offset(n: number) {
          offsetNum = n;
          return builder;
        },
        then(resolve: (val: any) => any, reject?: (err: any) => any) {
          try {
            const tableMap = getTableMap(store, currentTable);
            let items = Array.from(tableMap.values());
            for (const cond of conditions) {
              items = items.filter(cond);
            }
            if (sortCol) {
              items.sort((a, b) => {
                const valA = a[sortCol];
                const valB = b[sortCol];
                if (valA === valB) return 0;
                if (valA == null) return 1;
                if (valB == null) return -1;
                const cmp = valA < valB ? -1 : 1;
                return isDesc ? -cmp : cmp;
              });
            }
            const sliced = items.slice(offsetNum, offsetNum + limitNum);

            // If selection is { value: count() } or { count: ... }
            if (selection && typeof selection === "object") {
              if ("value" in selection || "count" in selection) {
                return Promise.resolve([{ value: items.length, count: items.length }]).then(
                  resolve,
                  reject
                );
              }
              if ("latest" in selection) {
                const maxVal = items.reduce(
                  (max, it) => Math.max(max, Number(it.version ?? 0)),
                  0
                );
                return Promise.resolve([{ latest: maxVal }]).then(resolve, reject);
              }
            }

            return Promise.resolve(sliced).then(resolve, reject);
          } catch (err) {
            if (reject) return Promise.reject(err).catch(reject);
            throw err;
          }
        },
      };
      return builder;
    },

    insert(table: any) {
      const tableName = getTableName(table);
      return {
        values(vals: any) {
          const items = Array.isArray(vals) ? vals : [vals];
          const tableMap = getTableMap(store, tableName);
          const inserted: any[] = [];
          for (const item of items) {
            const copy = { ...item };
            if (!copy.id) {
              copy.id =
                tableName === "users" || tableName === "workspaceSettings"
                  ? tableMap.size + 1
                  : `${tableName.slice(0, 3)}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            }
            if (!copy.createdAt) copy.createdAt = new Date();
            if (!copy.updatedAt) copy.updatedAt = new Date();
            if (!copy.status && tableName === "approvals") copy.status = "pending";
            if (!copy.decisionSource && tableName === "approvals") copy.decisionSource = "manual";
            tableMap.set(copy.id, copy);
            inserted.push(copy);
          }

          return {
            onDuplicateKeyUpdate(opts: any) {
              for (const it of inserted) {
                for (const [, existing] of tableMap.entries()) {
                  if (it.openId && existing.openId === it.openId) {
                    Object.assign(existing, opts?.set ?? it, { updatedAt: new Date() });
                  }
                }
              }
              return {
                then: (resolve: any) => Promise.resolve(inserted).then(resolve),
              };
            },
            then: (resolve: any) => Promise.resolve(inserted).then(resolve),
          };
        },
      };
    },

    update(table: any) {
      const tableName = getTableName(table);
      let updateSet: any = {};
      const conditions: Array<(item: any) => boolean> = [];

      return {
        set(values: any) {
          updateSet = values;
          return {
            where(expr: any) {
              if (expr) conditions.push(createFilter(expr));
              return {
                then: (resolve: any) => {
                  const tableMap = getTableMap(store, tableName);
                  let affectedRows = 0;
                  for (const [, item] of tableMap.entries()) {
                    if (conditions.every((c) => c(item))) {
                      Object.assign(item, updateSet, { updatedAt: new Date() });
                      affectedRows++;
                    }
                  }
                  return Promise.resolve([{ affectedRows }]).then(resolve);
                },
              };
            },
          };
        },
      };
    },

    delete(table: any) {
      const tableName = getTableName(table);
      const conditions: Array<(item: any) => boolean> = [];
      return {
        where(expr: any) {
          if (expr) conditions.push(createFilter(expr));
          return {
            then: (resolve: any) => {
              const tableMap = getTableMap(store, tableName);
              for (const [id, item] of Array.from(tableMap.entries())) {
                if (conditions.every((c) => c(item))) {
                  tableMap.delete(id);
                }
              }
              return Promise.resolve().then(resolve);
            },
          };
        },
      };
    },
  };

  return db;
}

export function seedInitialStore(): StoreData {
  const store: StoreData = new Map();

  const now = new Date();

  // 1. Users
  const usersMap = getTableMap(store, "users");
  usersMap.set(1, {
    id: 1,
    openId: "owner_dev",
    name: "Sahil (Owner)",
    email: "owner@freelancehr.local",
    role: "admin",
    loginMethod: "local",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  });

  // 2. Workspace Settings
  const wsMap = getTableMap(store, "workspaceSettings");
  wsMap.set(1, {
    id: 1,
    ownerId: 1,
    businessName: "FreelanceHR Operations",
    businessTimezone: "Asia/Kolkata",
    automationMode: "controlled",
    emergencyStop: false,
    dailyOutboundLimit: 25,
    quietHoursStart: "20:00",
    quietHoursEnd: "08:00",
    policyConfig: { aiDailyLimit: 45 },
    createdAt: now,
    updatedAt: now,
  });

  // 3. Companies / Prospects
  const cmpMap = getTableMap(store, "companies");
  cmpMap.set("cmp_acme", {
    id: "cmp_acme",
    ownerId: 1,
    name: "Acme Cloud Systems",
    domain: "acmecloud.io",
    sector: "Cloud Infrastructure",
    location: "Bengaluru, India",
    companyType: "client",
    pipelineState: "active",
    sourceType: "manual",
    confidence: 95,
    hiringSignal: "Scaling distributed platform team, 4 backend roles open",
    verificationState: "verified",
    createdAt: now,
    updatedAt: now,
  });
  cmpMap.set("cmp_health", {
    id: "cmp_health",
    ownerId: 1,
    name: "HealthTech Innovations",
    domain: "healthtech.ai",
    sector: "Healthcare AI",
    location: "Mumbai, India",
    companyType: "prospect",
    pipelineState: "active",
    sourceType: "inbound",
    confidence: 88,
    hiringSignal: "Series A closed, looking for Senior Full Stack Engineer",
    verificationState: "unverified",
    createdAt: now,
    updatedAt: now,
  });
  cmpMap.set("cmp_finflow", {
    id: "cmp_finflow",
    ownerId: 1,
    name: "FinFlow Global",
    domain: "finflow.dev",
    sector: "Fintech",
    location: "Singapore / Remote",
    companyType: "prospect",
    pipelineState: "new",
    sourceType: "referral",
    confidence: 78,
    hiringSignal: "Replacing legacy billing gateway, needs Golang / TypeScript lead",
    verificationState: "unverified",
    createdAt: now,
    updatedAt: now,
  });

  // 4. Jobs
  const jobsMap = getTableMap(store, "jobs");
  jobsMap.set("job_backend", {
    id: "job_backend",
    ownerId: 1,
    companyId: "cmp_acme",
    title: "Senior Backend Engineer (Distributed Systems)",
    pipelineState: "screening",
    requirementQuality: 94,
    mustHaveSkills: ["TypeScript", "Node.js", "MySQL", "Distributed Systems"],
    niceToHaveSkills: ["Docker", "Kubernetes", "tRPC"],
    scorecard: [
      { criterion: "Distributed Systems Architecture", weight: 40, required: true },
      { criterion: "Clean Code & Reliability", weight: 30, required: true },
      { criterion: "Communication & Technical Ownership", weight: 30, required: false },
    ],
    createdAt: now,
    updatedAt: now,
  });
  jobsMap.set("job_fullstack", {
    id: "job_fullstack",
    ownerId: 1,
    companyId: "cmp_health",
    title: "Lead Full Stack React / Node Engineer",
    pipelineState: "sourcing",
    requirementQuality: 89,
    mustHaveSkills: ["React", "TypeScript", "Tailwind CSS", "Node.js"],
    niceToHaveSkills: ["Next.js", "MySQL", "GraphQL"],
    scorecard: [
      { criterion: "Frontend Craft & Component UX", weight: 50, required: true },
      { criterion: "API Design & Data Modeling", weight: 50, required: true },
    ],
    createdAt: now,
    updatedAt: now,
  });

  // 5. Candidates
  const candMap = getTableMap(store, "candidates");
  candMap.set("cand_aarav", {
    id: "cand_aarav",
    ownerId: 1,
    fullName: "Aarav Sharma",
    headline: "Senior Full Stack & Distributed Systems Engineer",
    email: "aarav.sharma@example.com",
    phone: "+91 98765 43210",
    location: "Bengaluru, India",
    sourceType: "referral",
    profileState: "active",
    currentEmployer: "HyperScale Labs",
    currentTitle: "Senior Systems Engineer",
    yearsExperience: 6,
    parsedSkills: ["TypeScript", "Node.js", "React", "MySQL", "AWS"],
    sourceCollectedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  candMap.set("cand_priya", {
    id: "cand_priya",
    ownerId: 1,
    fullName: "Priya Patel",
    headline: "Lead Backend Developer (Node / High-Scale Systems)",
    email: "priya.patel@example.com",
    phone: "+91 98123 45678",
    location: "Pune, India",
    sourceType: "manual",
    profileState: "active",
    currentEmployer: "DataFlow Tech",
    currentTitle: "Lead Backend Engineer",
    yearsExperience: 8,
    parsedSkills: ["Node.js", "TypeScript", "MySQL", "Redis", "Kafka"],
    sourceCollectedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // 6. Interviews
  const intMap = getTableMap(store, "interviews");
  intMap.set("int_01", {
    id: "int_01",
    ownerId: 1,
    jobId: "job_backend",
    candidateId: "cand_aarav",
    status: "scheduled",
    scheduledAt: new Date(Date.now() + 86400000 * 2),
    timezone: "Asia/Kolkata",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    notes: "Technical deep-dive interview with VP of Engineering",
    createdAt: now,
    updatedAt: now,
  });

  // 7. Placements
  const plcMap = getTableMap(store, "placements");
  plcMap.set("plc_01", {
    id: "plc_01",
    ownerId: 1,
    companyId: "cmp_acme",
    jobId: "job_backend",
    candidateId: "cand_priya",
    status: "offer_pending",
    annualCompensation: "2400000",
    createdAt: now,
    updatedAt: now,
  });

  // 8. Invoices
  const invMap = getTableMap(store, "invoices");
  invMap.set("inv_01", {
    id: "inv_01",
    ownerId: 1,
    companyId: "cmp_acme",
    placementId: "plc_01",
    invoiceNumber: "INV-2026-001",
    amount: "200000",
    taxAmount: "36000",
    status: "draft",
    dueAt: new Date(Date.now() + 86400000 * 15),
    createdAt: now,
    updatedAt: now,
  });

  // 9. Approvals
  const appMap = getTableMap(store, "approvals");
  appMap.set("app_01", {
    id: "app_01",
    ownerId: 1,
    actionType: "client_onboarding",
    status: "pending",
    resourceType: "company",
    resourceId: "cmp_health",
    reason: "HealthTech Innovations requested service agreement and fee structure approval",
    payload: { terms: "8.33% fee, 90 days guarantee" },
    createdAt: now,
    updatedAt: now,
  });

  // 10. Audit Events
  const audMap = getTableMap(store, "auditEvents");
  audMap.set("aud_01", {
    id: "aud_01",
    ownerId: 1,
    actorType: "user",
    actorId: "1",
    action: "workspace.initialized",
    resourceType: "workspace",
    resourceId: "1",
    createdAt: new Date(Date.now() - 3600000 * 4),
  });
  audMap.set("aud_02", {
    id: "aud_02",
    ownerId: 1,
    actorType: "user",
    actorId: "1",
    action: "candidate.profile_added",
    resourceType: "candidate",
    resourceId: "cand_aarav",
    createdAt: new Date(Date.now() - 3600000 * 2),
  });
  audMap.set("aud_03", {
    id: "aud_03",
    ownerId: 1,
    actorType: "user",
    actorId: "1",
    action: "job.created",
    resourceType: "job",
    resourceId: "job_backend",
    createdAt: new Date(Date.now() - 3600000),
  });

  // 11. Policy Versions
  const polMap = getTableMap(store, "policyVersions");
  polMap.set("pol_01", {
    id: "pol_01",
    ownerId: 1,
    version: 1,
    name: "Standard Recruitment Governance v1",
    status: "active",
    content: {
      aiDailyLimit: 45,
      requireConsentBeforeShare: true,
      dataRetentionDays: 365,
    },
    createdById: 1,
    createdAt: now,
    activatedAt: now,
  });

  // 12. Team Members
  const teamMap = getTableMap(store, "teamMembers");
  teamMap.set("tm_01", {
    id: "tm_01",
    ownerId: 1,
    email: "owner@freelancehr.local",
    displayName: "Sahil (Owner)",
    role: "owner",
    status: "active",
    memberUserId: 1,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return store;
}
