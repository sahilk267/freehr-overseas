import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

type CookieCall = {
  name: string;
  options: Record<string, unknown>;
};

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext; clearedCookies: CookieCall[] } {
  const clearedCookies: CookieCall[] = [];

  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };

  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    });
  });

  it("clears the OIDC session cookie when the portable production runtime is active", async () => {
    const originalMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "oidc";
    const headers: Record<string, string> = {};
    const { ctx } = createAuthContext();
    ctx.res = { setHeader: (name: string, value: string) => { headers[name] = value; } } as TrpcContext["res"];
    const caller = appRouter.createCaller(ctx);
    await expect(caller.auth.logout()).resolves.toEqual({ success: true });
    expect(headers["Set-Cookie"]).toContain("__Host-fh_session=");
    expect(headers["Set-Cookie"]).toContain("Max-Age=0");
    if (originalMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = originalMode;
  });
});
