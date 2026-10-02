import { trpc } from "@/lib/trpc";
import { COOKIE_NAME, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { startLogin } from "./const";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry(failureCount, error) {
        if (error instanceof TRPCClientError) {
          const status = error.data?.httpStatus;
          if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
            return false;
          }
        }
        return failureCount < 3;
      },
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 5000),
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG || error.data?.code === "UNAUTHORIZED";

  if (!isUnauthorized) return;

  startLogin();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    const isPending = event.query.state.status === "pending" || event.query.state.fetchFailureCount < 2;
    const isUnauth = (error instanceof TRPCClientError && (error.data?.code === "UNAUTHORIZED" || error.data?.httpStatus === 401)) || error?.message === UNAUTHED_ERR_MSG;
    const isWarmupOrHtml = error instanceof TRPCClientError && (error.message?.includes("warming up") || error.message?.includes("temporarily unavailable"));
    const isSyntax = error instanceof SyntaxError && error.message.includes("is not valid JSON");
    const isMissingResult = Boolean((error as any)?.message?.includes("Missing result"));

    if (error && !isPending && !isUnauth && !isWarmupOrHtml && !isSyntax && !isMissingResult) {
      console.error("[API Query Error]", error);
    }
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    const isUnauth = (error instanceof TRPCClientError && (error.data?.code === "UNAUTHORIZED" || error.data?.httpStatus === 401)) || error?.message === UNAUTHED_ERR_MSG;
    const isWarmupOrHtml = error instanceof TRPCClientError && (error.message?.includes("warming up") || error.message?.includes("temporarily unavailable"));
    const isSyntax = error instanceof SyntaxError && error.message.includes("is not valid JSON");
    const isMissingResult = Boolean((error as any)?.message?.includes("Missing result"));

    if (error && !isUnauth && !isWarmupOrHtml && !isSyntax && !isMissingResult) {
      console.error("[API Mutation Error]", error);
    }
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpLink({
      url: "/api/trpc",
      transformer: superjson as any,
      headers() {
        // Preview auto-login fallback: when the browser blocks iframe cookies
        // (Safari ITP / private browsing / WebView), the runtime mirrors the
        // session into sessionStorage so we can forward it as a Bearer token.
        // The regular OAuth cookie flow keeps working and takes priority server-side.
        const headers: Record<string, string> = {};
        try {
          const raw = sessionStorage.getItem("manus-cookie");
          if (raw) {
            const prefix = `${COOKIE_NAME}=`;
            const pair = raw.split(";").find(s => s.trim().startsWith(prefix));
            const token = pair?.trim().slice(prefix.length);
            if (token) {
              headers.Authorization = `Bearer ${token}`;
            }
          }
          const activeWorkspace = sessionStorage.getItem("freelancehr-active-workspace");
          if (activeWorkspace && /^\d{1,10}$/.test(activeWorkspace)) headers["x-freelancehr-workspace"] = activeWorkspace;
        } catch {
          // sessionStorage unavailable
        }
        return headers;
      },
      async fetch(input, init) {
        const response = await globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });

        // Guard against non-JSON or malformed error responses (e.g. reverse proxy 502/503 HTML error pages or non-superjson API errors)
        const contentType = response.headers.get("content-type") || "";
        const isJson = contentType.includes("application/json");

        if (!response.ok || !isJson) {
          const text = await response.text();
          let parsed: any = null;
          if (isJson) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }

          const hasValidTrpcStructure = Boolean(parsed?.error?.json || parsed?.result || (Array.isArray(parsed) && (parsed[0]?.error?.json || parsed[0]?.result)));

          if (!hasValidTrpcStructure) {
            const isHtml = text.trim().startsWith("<") || contentType.includes("text/html");
            const isAuthRedirect = response.redirected || text.includes("applet-auth-bridge") || text.includes("cookie_check");

            if (isAuthRedirect) {
              const synthesized = JSON.stringify({
                error: {
                  json: {
                    message: UNAUTHED_ERR_MSG,
                    code: -32001,
                    data: {
                      code: "UNAUTHORIZED",
                      httpStatus: 401,
                    },
                  },
                },
              });

              return new Response(synthesized, {
                status: 401,
                statusText: "Unauthorized",
                headers: { "content-type": "application/json" },
              });
            }

            const errorHttpStatus = response.status >= 400 ? response.status : 503;
            const isWarmup = text.includes("warmup") || response.status === 502 || response.status === 503 || response.status === 504;
            let safeMessage = isWarmup
              ? "Service is warming up. Please wait..."
              : isHtml
              ? `Service temporarily unavailable (${errorHttpStatus})`
              : text || `Request failed with status ${errorHttpStatus}`;

            if (parsed && typeof parsed === "object") {
              safeMessage = parsed.message || parsed.error || JSON.stringify(parsed);
            }

            const synthesized = JSON.stringify({
              error: {
                json: {
                  message: safeMessage,
                  code: -32603,
                  data: {
                    code: "INTERNAL_SERVER_ERROR",
                    httpStatus: errorHttpStatus,
                  },
                },
              },
            });

            return new Response(synthesized, {
              status: errorHttpStatus,
              statusText: response.statusText || "Service Unavailable",
              headers: {
                "content-type": "application/json",
              },
            });
          }

          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return response;
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
