import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { runWithAuditActor } from "../services/actorContext";
import { canAccessWorkspacePath, canUseApplication, isPrimaryOwner, requestedWorkspaceId, resolveWorkspaceAccess } from "../services/workspaceAccess";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  const actor = ctx.user;
  if (!canUseApplication(actor)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "FreelanceHR is currently in owner-only testing mode." });
  }
  const workspace = await resolveWorkspaceAccess(actor, requestedWorkspaceId(ctx.req));
  const selfServicePath = ["team.accept", "team.myAccess", "team.permissions", "accept", "myAccess", "permissions"].includes(opts.path);
  if (actor.role !== "admin" && !isPrimaryOwner(actor) && workspace.isOwner && !selfServicePath) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Activate and select an owner-approved team workspace before accessing operational records." });
  }
  if (!canAccessWorkspacePath(workspace, opts.path)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Your team role is not permitted to perform this workspace action." });
  }
  const workspaceUser = { ...actor, id: workspace.ownerId };
  return runWithAuditActor({ userId: actor.id, role: workspace.role, workspaceOwnerId: workspace.ownerId }, () => next({
    ctx: {
      ...ctx,
      user: workspaceUser,
      actor,
      workspace,
    },
  }));
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
