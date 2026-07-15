#!/usr/bin/env node
/**
 * Local-only DB password fingerprint tool.
 *
 * Prompts for the *intended* DB_PASSWORD, without ever echoing, storing, or
 * transmitting it, and prints a small set of safe fingerprint fields
 * (length, whitespace/quote/newline flags, and an 8-character SHA-256
 * prefix). Compare this output against the `dbPasswordLength` /
 * `dbPasswordSha256Prefix` etc. fields returned by the protected
 * GET /api/internal/test/mysql-connection endpoint on the deployed app to
 * find out whether the value Hostinger is actually running with matches
 * the password you intended to set — without ever revealing either value.
 *
 * Nothing here is written to disk, logged, or sent over the network.
 */

import { createHash } from "node:crypto";

// Named via charCode rather than escape literals to keep this file free of
// embedded raw control bytes.
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(8);
const DEL = String.fromCharCode(127);

function isEnterKey(char) {
  return char === "\n" || char === "\r";
}

function promptPassword(promptText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      reject(new Error("This script must be run in an interactive terminal."));
      return;
    }

    stdout.write(promptText);

    let input = "";
    let settled = false;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write("\n");
      resolve(input);
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write("\n");
      process.exitCode = 130;
      resolve(null);
    };

    function onData(chunk) {
      for (const char of chunk) {
        if (isEnterKey(char) || char === CTRL_D) {
          finish();
          return;
        }
        if (char === CTRL_C) {
          cancel();
          return;
        }
        if (char === DEL || char === BACKSPACE) {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        input += char;
        stdout.write("*");
      }
    }

    stdin.on("data", onData);
  });
}

function fingerprint(password) {
  const sha256 = createHash("sha256").update(password, "utf8").digest("hex");

  return {
    length: password.length,
    startsWithWhitespace: /^\s/.test(password),
    endsWithWhitespace: /\s$/.test(password),
    containsNewline: password.includes("\n"),
    containsCarriageReturn: password.includes("\r"),
    containsSingleQuote: password.includes("'"),
    containsDoubleQuote: password.includes('"'),
    sha256Prefix: sha256.slice(0, 8),
  };
}

async function main() {
  console.log(
    "BrawlRanks — DB password fingerprint tool (local only; nothing is stored, logged, or transmitted)"
  );

  const password = await promptPassword("Enter the intended DB_PASSWORD: ");

  if (password === null) {
    console.error("Cancelled — no fingerprint printed.");
    return;
  }

  if (password.length === 0) {
    console.error("No password entered — exiting without printing a fingerprint.");
    process.exitCode = 1;
    return;
  }

  const result = fingerprint(password);

  console.log("\nFingerprint (safe to share — does not reveal the password):");
  console.log(JSON.stringify(result, null, 2));
  console.log(
    "\nCompare `sha256Prefix` and `length` above against `dbPasswordSha256Prefix` and " +
      "`dbPasswordLength` from GET /api/internal/test/mysql-connection to confirm whether " +
      "the deployed runtime is using the password you intended."
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
