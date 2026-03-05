import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { type AuthConfig, getAuthConfig } from "@/lib/server/auth/settings";

type SearchParamsValue = string | string[] | undefined;

type LoginPageProps = {
  searchParams?: Promise<Record<string, SearchParamsValue>> | Record<string, SearchParamsValue>;
};

function toSingleValue(value: SearchParamsValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = (searchParams ? await searchParams : {}) as Record<string, SearchParamsValue>;
  const returnTo = sanitizeReturnTo(toSingleValue(resolvedSearchParams.returnTo));
  const error = toSingleValue(resolvedSearchParams.error);

  let authConfig: AuthConfig = { mode: "none", session: null, oidc: null, password: null };
  let configError: string | null = null;

  try {
    authConfig = getAuthConfig();
  } catch (caughtError) {
    configError = caughtError instanceof Error ? caughtError.message : "Auth configuration is invalid";
  }

  const ssoLoginUrl = returnTo === "/" ? "/api/auth/login" : `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const continueUrl = returnTo === "/" ? "/" : returnTo;

  return (
    <main className="container flex min-h-[calc(100vh-8rem)] items-center justify-center py-10">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Sign in to PaperDock</CardTitle>
          <CardDescription>
            {authConfig.mode === "oidc" ? "Continue with your configured SSO provider." : null}
            {authConfig.mode === "password" ? "Sign in with the configured local credentials." : null}
            {authConfig.mode === "both" ? "Use SSO or local username/password." : null}
            {authConfig.mode === "none" ? "Authentication is disabled for this deployment." : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          {configError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{configError}</p>
          ) : null}

          {!configError && (authConfig.mode === "oidc" || authConfig.mode === "both") ? (
            <Button asChild className="w-full">
              <a href={ssoLoginUrl}>Continue with SSO</a>
            </Button>
          ) : null}

          {!configError && (authConfig.mode === "password" || authConfig.mode === "both") ? (
            <form action="/api/auth/password" method="post" className="space-y-4">
              <input type="hidden" name="returnTo" value={returnTo} />
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input id="username" name="username" autoComplete="username" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </div>
              <Button type="submit" className="w-full">
                Sign in
              </Button>
            </form>
          ) : null}

          {!configError && authConfig.mode === "none" ? (
            <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
              No authentication is enabled. You can continue directly to the app.
            </p>
          ) : null}

          {!configError && authConfig.mode === "none" ? (
            <Button asChild className="w-full">
              <a href={continueUrl}>Continue to PaperDock</a>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
