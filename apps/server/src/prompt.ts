// One line from the terminal, for the admin CLIs (user:*, app:purge).

/** Read one line; hidden input is not echoed (raw mode on a terminal). */
export function prompt(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    const tty = stdin.isTTY && hidden;
    if (tty) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      if (tty) stdin.setRawMode(false);
      stdin.pause();
      if (tty) process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
