// Dashboard user administration. Users exist only through these commands;
// every change is written to the auth audit log with actor "cli".
//
//   npm run user:create -- <name>     password prompted (never argv), TOTP enrolment
//   npm run user:disable -- <name>    signs the user out everywhere
//   npm run user:reset-mfa -- <name>  new TOTP secret; inactive until a code proves it
//   npm run user:unlock -- <name>     ends a sign-in lockout
//
// Every command refuses to run without ABIGAAIL_DASHBOARD_SECRET: it seals the
// TOTP secrets, and the dashboard needs the same value to check codes.

import { enrolmentStep, hashPassword, MIN_PASSWORD_LENGTH, newTotpSecret, otpauthUri, SecretKey } from "@abigaail/auth";
import { openAuthStore, type AuthStore } from "@abigaail/store";

export interface UserCliDeps {
  env: NodeJS.ProcessEnv;
  authDbPath: string;
  /** Ask for a value; `hidden` must not echo it. */
  prompt: (question: string, hidden: boolean) => Promise<string>;
  print: (line: string) => void;
  now?: () => number;
}

const USAGE = "usage: user:create | user:disable | user:reset-mfa | user:unlock -- <name>";

export async function runUserCommand(command: string | undefined, name: string | undefined, deps: UserCliDeps): Promise<void> {
  // Before anything is opened or asked: without the secret nothing can be sealed or checked.
  const key = SecretKey.fromEnv(deps.env);
  if (!command || !["create", "disable", "reset-mfa", "unlock"].includes(command)) throw new Error(USAGE);
  if (!name) throw new Error(USAGE);
  const store = openAuthStore(deps.authDbPath, deps.now ? { now: deps.now } : {});
  try {
    switch (command) {
      case "create": {
        if (store.userByName(name)) throw new Error(`user "${name}" already exists`);
        const password = await deps.prompt(`Password for ${name} (at least ${MIN_PASSWORD_LENGTH} characters): `, true);
        const again = await deps.prompt("Repeat password: ", true);
        if (password !== again) throw new Error("passwords do not match");
        const passHash = await hashPassword(password);
        const secret = newTotpSecret();
        store.createUser(name, passHash, key.seal(secret, name), "cli");
        await enrol(store, name, secret, deps);
        break;
      }
      case "reset-mfa": {
        const secret = newTotpSecret();
        if (!store.resetMfa(name, key.seal(secret, name), "cli")) throw new Error(`no user named "${name}"`);
        deps.print(`"${name}" is signed out and inactive until the new code is confirmed.`);
        await enrol(store, name, secret, deps);
        break;
      }
      case "disable":
        if (!store.disableUser(name, "cli")) throw new Error(`no enabled user named "${name}"`);
        deps.print(`Disabled "${name}" and ended their sessions.`);
        break;
      case "unlock": {
        if (!store.userByName(name)) throw new Error(`no user named "${name}"`);
        const cleared = store.unlock(name, "cli");
        deps.print(cleared ? `Unlocked "${name}" (${cleared} recent failure${cleared === 1 ? "" : "s"} cleared).` : `"${name}" was not locked.`);
        break;
      }
    }
  } finally {
    store.close();
  }
}

/** Show the secret once, then activate only after a code from the authenticator matches. */
async function enrol(store: AuthStore, name: string, secret: string, deps: UserCliDeps): Promise<void> {
  deps.print("");
  deps.print("Add this account to your authenticator app (shown once, not stored in plain text):");
  deps.print(`  Secret: ${secret}`);
  deps.print(`  URI:    ${otpauthUri(name, secret)}`);
  deps.print("");
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await deps.prompt("Code from the app: ", false);
    const step = enrolmentStep(secret, code, deps.now?.() ?? Date.now());
    if (step !== undefined && store.activateUser(name, step, "cli")) {
      deps.print(`"${name}" is active. Sign in at the dashboard with name, password and code.`);
      return;
    }
    deps.print("That code does not match. Check the app's clock and try again.");
  }
  throw new Error(`"${name}" stays inactive; run npm run user:reset-mfa -- ${name} to try again`);
}
