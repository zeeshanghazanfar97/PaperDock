import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { getAuthSettings } from "@/lib/server/auth/settings";

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

  let authEnabled = false;
  let configError: string | null = null;

  try {
    authEnabled = Boolean(getAuthSettings());
  } catch (caughtError) {
    configError = caughtError instanceof Error ? caughtError.message : "OIDC configuration is invalid";
  }

  const loginUrl = returnTo === "/" ? "/api/auth/login" : `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="container flex min-h-[calc(100vh-8rem)] items-center justify-center py-10">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Sign in to PaperDock</CardTitle>
          <CardDescription>PaperDock now uses OAuth2/OpenID Connect for authentication.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          {configError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{configError}</p>
          ) : null}

          {authEnabled ? (
            <Button asChild className="w-full">
              <a href={loginUrl}>Continue with SSO</a>
            </Button>
          ) : (
            <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
              OIDC settings are not configured yet. Add the required auth values in `.env` and restart the app.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
