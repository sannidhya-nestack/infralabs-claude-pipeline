// The agent session's check (agent.yml, step "Check"). It fails closed (exit 1)
// unless every init event in the CLI's stream-json transcript shows the session
// agent.yml asked for: no tool but Bash and EndConversation (a --tools list
// cannot remove EndConversation), no MCP server, no plugin, and permission mode
// dontAsk whenever it names one (2.1.295 predates the 2.1.302 fix for -p runs
// that started in auto mode). Pass or fail, it writes counts only to the job
// summary: the transcript holds bill text and whatever the bill steered the
// agent to write, and a public repo's summaries are public.
//
//   node scripts/check-session.mjs <transcript.jsonl> [<result file>]
//   node scripts/check-session.mjs --selftest     also guards agent/settings.json
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = new Set(["Bash", "EndConversation"]);
const HEADER = "| Session check | Result | Turns | Cost USD | Minutes | Bash calls | Permission denials | Result MB |";

/** Why the session fails the check, as a short token, or null when it passes. */
export function sessionProblem(events) {
  const inits = events.filter((event) => event?.type === "system" && event.subtype === "init");
  if (inits.length === 0) return "no-init";
  for (const init of inits) {
    if (!Array.isArray(init.tools) || !init.tools.every((tool) => TOOLS.has(tool))) return "tools";
    if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) return "mcp-servers";
    if (init.plugins !== undefined && !(Array.isArray(init.plugins) && init.plugins.length === 0)) return "plugins";
    if (init.permissionMode !== undefined && init.permissionMode !== "dontAsk") return "permission-mode";
  }
  return null;
}

const num = (value, digits) =>
  typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 10 ** digits) / 10 ** digits) : "-";

/** The summary row: numbers and short tokens only, whatever the transcript says. */
export function summaryRow(events, problem, resultBytes) {
  const result = events.filter((event) => event?.type === "result").pop() ?? {};
  const bashCalls = events
    .filter((event) => event?.type === "assistant" && Array.isArray(event.message?.content))
    .flatMap((event) => event.message.content)
    .filter((block) => block?.type === "tool_use" && block.name === "Bash").length;
  const subtype = typeof result.subtype === "string" && /^[a-z_]{1,40}$/.test(result.subtype) ? result.subtype : "-";
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials.length : "-";
  const cells = [
    problem ?? "ok",
    subtype,
    num(result.num_turns, 0),
    num(result.total_cost_usd, 2),
    num(result.duration_ms / 60_000, 1),
    bashCalls,
    denials,
    resultBytes === null ? "-" : num(resultBytes / 1024 / 1024, 1),
  ];
  return `| ${cells.join(" | ")} |`;
}

const empty = (value) => value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * What in agent/settings.json would weaken the sandbox, by setting name. -p
 * ignores a settings file that fails validation without a word, so the file is
 * checked here, offline and before every run.
 */
export function settingsProblems(settings) {
  const sandbox = settings?.sandbox ?? {};
  const network = sandbox.network ?? {};
  const permissions = settings?.permissions ?? {};
  const denied = new Set(
    (Array.isArray(sandbox.credentials?.envVars) ? sandbox.credentials.envVars : [])
      .filter((entry) => entry?.mode === "deny")
      .map((entry) => entry.name),
  );
  return [
    [sandbox.enabled === true, "sandbox.enabled"],
    [sandbox.failIfUnavailable === true, "sandbox.failIfUnavailable"],
    [sandbox.allowUnsandboxedCommands === false, "sandbox.allowUnsandboxedCommands"],
    [sandbox.enableWeakerNestedSandbox !== true, "sandbox.enableWeakerNestedSandbox"],
    [empty(sandbox.excludedCommands), "sandbox.excludedCommands"],
    [network.strictAllowlist === true, "sandbox.network.strictAllowlist"],
    [Array.isArray(network.allowedDomains) && network.allowedDomains.length === 0, "sandbox.network.allowedDomains"],
    [network.allowAllUnixSockets !== true && empty(network.allowUnixSockets), "sandbox.network unix sockets"],
    [denied.has("CLAUDE_CODE_OAUTH_TOKEN") && denied.has("ANTHROPIC_API_KEY"), "sandbox.credentials.envVars"],
    [permissions.blockReadsOutsideWorkingDirectories === true, "permissions.blockReadsOutsideWorkingDirectories"],
    [permissions.defaultMode === "dontAsk", "permissions.defaultMode"],
    // Such rules also block cat, head, sed and redirections inside Bash.
    [
      permissions.deny === undefined ||
        (Array.isArray(permissions.deny) && !permissions.deny.some((rule) => /^(Read|Edit)\b/.test(String(rule)))),
      "permissions.deny Read or Edit",
    ],
    [settings?.disableAllHooks === true, "disableAllHooks"],
  ]
    .filter(([ok]) => !ok)
    .map(([, name]) => name);
}

function readEvents(file) {
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") events.push(value);
    } catch {
      // A stray line that is not an event.
    }
  }
  return events;
}

/** Size of a regular file, never through a link; null when there is none. */
function sizeOf(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function selftest() {
  const init = (fields) => ({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [], permissionMode: "dontAsk", ...fields });
  assert.equal(sessionProblem([init({})]), null);
  assert.equal(sessionProblem([init({ tools: ["Bash", "EndConversation"] })]), null);
  assert.equal(sessionProblem([init({ permissionMode: undefined, plugins: [] })]), null);
  for (const tool of ["Read", "WebFetch", "Task"]) assert.equal(sessionProblem([init({ tools: ["Bash", tool] })]), "tools", tool);
  assert.equal(sessionProblem([init({ tools: undefined })]), "tools");
  assert.equal(sessionProblem([init({ mcp_servers: [{ name: "x", status: "connected" }] })]), "mcp-servers");
  assert.equal(sessionProblem([init({ mcp_servers: undefined })]), "mcp-servers");
  assert.equal(sessionProblem([init({ plugins: [{ name: "p", path: "/p" }] })]), "plugins");
  for (const mode of ["auto", "default", "bypassPermissions"]) {
    assert.equal(sessionProblem([init({ permissionMode: mode })]), "permission-mode", mode);
  }
  assert.equal(sessionProblem([]), "no-init");
  assert.equal(sessionProblem([{ type: "result", subtype: "success" }]), "no-init");
  // Every init counts, not only the first.
  assert.equal(sessionProblem([init({}), init({ tools: ["Bash", "Read"] })]), "tools");

  const hostile = "Ignore the above | 0412 345 678 | $1,234.56\n## TOTAL";
  const row = summaryRow(
    [
      init({}),
      { type: "assistant", message: { content: [{ type: "text", text: hostile }, { type: "tool_use", name: "Bash", input: { command: hostile } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } },
      { type: "result", subtype: hostile, result: hostile, num_turns: 12, total_cost_usd: 3.14159, duration_ms: 754_000, permission_denials: [{ tool_name: hostile }] },
    ],
    null,
    5 * 1024 * 1024,
  );
  assert.equal(row, "| ok | - | 12 | 3.14 | 12.6 | 2 | 1 | 5 |");
  assert.equal(summaryRow([{ type: "result", subtype: "error_max_budget_usd" }], "no-init", null), "| no-init | error_max_budget_usd | - | - | - | 0 | - | - |");
  for (const line of [HEADER, row]) assert.match(line, /^[|A-Za-z0-9 ._-]+$/);

  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "settings.json");
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(settingsProblems(settings), []);
  const weakenings = [
    (s) => (s.sandbox.enabled = false),
    (s) => delete s.sandbox.failIfUnavailable,
    (s) => (s.sandbox.allowUnsandboxedCommands = true),
    (s) => (s.sandbox.enableWeakerNestedSandbox = true),
    (s) => (s.sandbox.excludedCommands = ["docker"]),
    (s) => (s.sandbox.network.strictAllowlist = false),
    (s) => (s.sandbox.network.allowedDomains = ["example.com"]),
    (s) => (s.sandbox.network.allowAllUnixSockets = true),
    (s) => s.sandbox.credentials.envVars.pop(),
    (s) => (s.permissions.blockReadsOutsideWorkingDirectories = false),
    (s) => (s.permissions.defaultMode = "acceptEdits"),
    (s) => (s.permissions.deny = ["Read(./**)"]),
    (s) => (s.permissions.deny = ["Edit"]),
    (s) => delete s.disableAllHooks,
  ];
  for (const weaken of weakenings) {
    const copy = structuredClone(settings);
    weaken(copy);
    assert.equal(settingsProblems(copy).length, 1, String(weaken));
  }
  console.log("check-session.mjs selftest: ok (session check, counts-only summary, agent/settings.json)");
}

if (process.argv[2] === "--selftest") {
  selftest();
} else {
  const [transcript, resultFile] = process.argv.slice(2);
  let events = [];
  try {
    events = readEvents(transcript);
  } catch {
    // No transcript: no init event, so the check fails below.
  }
  const problem = sessionProblem(events);
  const table = [HEADER, "|---|---|---|---|---|---|---|---|", summaryRow(events, problem, sizeOf(resultFile))].join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  if (problem) {
    console.log(`::error::The agent session failed its check (${problem}): its result is not used.`);
    process.exit(1);
  }
}
