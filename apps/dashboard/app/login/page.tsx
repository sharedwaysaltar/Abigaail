import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SIGN_IN_FAILED } from "@abigaail/auth";
import { Wordmark } from "@/components/Wordmark";
import { authenticator, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// The one page that does not require a session.
export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (authenticator().session((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/");
  const { e } = await searchParams;
  return (
    <main className="signin">
      <Wordmark href="/login" />
      <form method="post" action="/api/login">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} autoFocus />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        <label htmlFor="code">Code from your authenticator</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required maxLength={7} />
        <button type="submit">Sign in</button>
        {e ? <p className="error" role="alert">{SIGN_IN_FAILED}</p> : null}
      </form>
      <p className="note">Accounts are created with npm run user:create.</p>
    </main>
  );
}
