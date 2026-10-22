#!/usr/bin/env bash
# Database access for the workflow steps. Source it, then query:
#
#   source scripts/db.sh
#   db_query "SELECT ..."
#
# DATABASE_URL becomes a 0600 option file under $RUNNER_TEMP, and every part of
# it is masked before anything else can print it. mysql errors go to a file that
# is never printed, because they name the host and the user. Nothing goes to
# $GITHUB_ENV: each step that needs the database sources this again.

DB_CNF="$RUNNER_TEMP/my.cnf"
DB_ERR="$RUNNER_TEMP/mysql.err"
trap 'rm -f "$DB_CNF" "$DB_ERR"' EXIT

# Node, not shell: the URL parts are percent-encoded (the real password is) and
# must be decoded, then quoted for the option file. Node prints the masks itself,
# so the shell never holds a value.
DB_CNF="$DB_CNF" node <<'JS' || { echo "::error::DATABASE_URL is not set or not a mysql:// URL"; exit 1; }
const fs = require("fs");
try {
  const u = new URL(process.env.DATABASE_URL);
  if (u.protocol !== "mysql:") process.exit(1);
  const part = {
    host: u.hostname,
    port: u.port || "3306",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
  for (const value of [part.host, part.user, part.password, part.database, u.username, u.password]) {
    if (value) console.log(`::add-mask::${value}`);
  }
  // Double quotes keep "#" from starting a comment; backslash escapes the rest.
  const quote = (v) =>
    `"${v.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  const lines = Object.entries(part).map(([key, value]) => `${key}=${quote(value)}`);
  // REQUIRED, not the default PREFERRED: never fall back to plain text.
  fs.writeFileSync(process.env.DB_CNF, ["[client]", ...lines, "ssl-mode=REQUIRED", ""].join("\n"), { mode: 0o600 });
} catch {
  process.exit(1);
}
JS

# Prints the rows, tab separated, no header. On failure prints only the exit
# code and the MySQL error number, never the message.
db_query() {
  local code=0 err
  mysql --defaults-extra-file="$DB_CNF" -N -B -e "$1" 2>"$DB_ERR" || code=$?
  [ "$code" -eq 0 ] && return 0
  err=$(grep -o -m1 '^ERROR [0-9]*' "$DB_ERR" || true)
  echo "db query failed (exit $code${err:+, mysql $err})" >&2
  return "$code"
}

# Every id goes through this before it reaches SQL text or a gh argument:
# platform upload ids are cuids, so nothing else passes.
valid_id() {
  [[ "$1" =~ ^[a-z0-9]{20,40}$ ]]
}
