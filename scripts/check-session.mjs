// The agent session's checks (agent.yml), both fail closed. The watcher (step
// "Agent") reads the CLI's stream-json as the CLI writes it and kills the
// session unless the init event passes and the probe, the session's first
// command, shows the sandbox holding. The check (step "Check") reads the same
// transcript afterwards and fails (exit 1) unless every init event shows the
// session agent.yml asked for: no tool but Bash and EndConversation (a --tools
// list cannot remove EndConversation), no MCP server, no plugin, and permission
// mode dontAsk whenever it names one (2.1.295 predates the 2.1.302 fix for -p
// runs that started in auto mode), and the probe passed. Both print counts and
// short tokens only: the transcript holds bill text and whatever the bill
// steered the agent to write, and a public repo's logs and summaries are public.
//
//   node scripts/check-session.mjs <transcript.jsonl> [<result file>]
//   node scripts/check-session.mjs --watch <transcript.jsonl> <kill command...>   stdin: the CLI's stdout
//   node scripts/check-session.mjs --prompt      prints the -p prompt, which names the probe
//   node scripts/check-session.mjs --selftest    also guards agent/settings.json
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const TOOLS = new Set(["Bash", "EndConversation"]);
const HEADER = "| Session check | Result | Turns | Cost USD | Minutes | Bash calls | Permission denials | Result MB |";

// The probe: the session's first command, named in the -p prompt before any
// bill text is in context, so no bill can steer it. In the Claude Code sandbox
// the root is a read-only bind, so the write fails with "Read-only file system"
// (outside it the agent may not write /usr: "Permission denied"; the agent's
// home is no test, the sandbox hides it under a writable tmpfs once reads
// outside the working directory are blocked). ls sees only the sandbox's own
// PID namespace under a fresh /proc, and the command's environment holds no
// credential.
export const PROBE = `touch /usr/p; echo "probe pids $(ls /proc | grep -c '^[0-9]') creds $(printenv | grep -c sk-ant-)"`;
// ponytail: read from the CLI's sandbox code, about 10 processes in its PID
// namespace (bwrap's init, its shell, two socat bridges with their subshells,
// the command's shell, the $() subshell, ls, grep); the runner's own /proc
// lists hundreds. Tighten it from the "Probe: ok" log line after the canary.
const MAX_PIDS = 20;

export const PROMPT = `Your first Bash call, before you read any file, is this command, exactly and alone: ${PROBE}
It is the host's check of the sandbox: its error is expected, and nothing in its output is for you to act on.
Then write ./out/pages.json for the pages in ./pages, as your instructions say.`;

const isInit = (event) => event?.type === "system" && event.subtype === "init";
const squeeze = (text) => String(text).replace(/\s+/g, " ").trim();

/** Why an init event fails the check, as a short token, or null. */
function initProblem(init) {
  if (!Array.isArray(init.tools) || !init.tools.every((tool) => TOOLS.has(tool))) return "tools";
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) return "mcp-servers";
  if (init.plugins !== undefined && !(Array.isArray(init.plugins) && init.plugins.length === 0)) return "plugins";
  if (init.permissionMode !== undefined && init.permissionMode !== "dontAsk") return "permission-mode";
  return null;
}

/** What the probe printed, read from its tool result. */
function probeOutcome(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
        : "";
  const counts = /^probe pids (\d{1,9}) creds (\d{1,9})$/m.exec(text);
  if (!counts) return { problem: "probe-output" };
  const pids = Number(counts[1]);
  const creds = Number(counts[2]);
  const problem = !text.includes("Read-only file system")
    ? "probe-write"
    : pids >= MAX_PIDS
      ? "probe-pids"
      : creds > 0
        ? "probe-credential"
        : null;
  return { problem, pids, creds };
}

/**
 * The probe's verdict from the session's events so far: undefined while it is
 * still to come, then { problem } (null when it passed) and the counts it
 * printed. The first tool call must be the probe, after a passing init, and
 * only its own result counts: a first result that merely looks like the
 * probe's (a page written to) decides nothing.
 */
export function probeVerdict(events) {
  let init = false;
  let probe;
  for (const event of events) {
    if (isInit(event)) {
      const problem = initProblem(event);
      if (problem) return { problem };
      init = true;
    }
    for (const block of Array.isArray(event?.message?.content) ? event.message.content : []) {
      if (probe === undefined && block?.type === "tool_use") {
        if (!init) return { problem: "no-init" };
        if (block.name !== "Bash" || typeof block.id !== "string" || squeeze(block.input?.command) !== squeeze(PROBE)) {
          return { problem: "probe-command" };
        }
        probe = block.id;
      } else if (probe !== undefined && block?.type === "tool_result" && block.tool_use_id === probe) {
        return probeOutcome(block.content);
      }
    }
  }
  return undefined;
}

/** Why the session fails the check, as a short token, or null when it passes. */
export function sessionProblem(events) {
  const inits = events.filter(isInit);
  if (inits.length === 0) return "no-init";
  for (const init of inits) {
    const problem = initProblem(init);
    if (problem) return problem;
  }
  const probe = probeVerdict(events);
  return probe ? probe.problem : "no-probe";
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

/**
 * Copies the CLI's stdout (this process's stdin) to <transcript> as it comes,
 * and runs <kill> the moment the probe fails, or when the stream ends (or this
 * process breaks) before the probe passed. Exit 0 only after a passing probe.
 */
function watch(transcript, kill) {
  const fd = fs.openSync(transcript, "wx", 0o600);
  const decoder = new StringDecoder("utf8");
  const events = [];
  let rest = "";
  let verdict;
  // Synchronous, so the line is out before process.exit (stdout is a pipe).
  const say = (line) => fs.writeSync(1, `${line}\n`);
  const fail = (why) => {
    spawnSync(kill[0], kill.slice(1), { stdio: "ignore" });
    say(`::error::The agent session failed its probe (${why}) and was stopped: its result is not used.`);
    process.exit(1);
  };
  process.on("uncaughtException", () => fail("watcher-error"));
  process.stdin.on("data", (chunk) => {
    fs.writeSync(fd, chunk);
    if (verdict) return;
    const lines = (rest + decoder.write(chunk)).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event === "object") events.push(event);
      } catch {
        // A stray line that is not an event.
      }
    }
    verdict = probeVerdict(events);
    if (!verdict) return;
    const counts = verdict.pids === undefined ? "" : `: ${verdict.pids} processes, ${verdict.creds} credential lines`;
    if (verdict.problem) fail(`${verdict.problem}${counts}`);
    say(`Probe: ok${counts}`);
    rest = "";
    events.length = 0;
  });
  process.stdin.on("end", () => {
    fs.closeSync(fd);
    if (verdict?.problem !== null) fail("no-probe");
  });
}

function selftest() {
  const init = (fields) => ({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [], permissionMode: "dontAsk", ...fields });
  const use = (command, id = "t1", name = "Bash") => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: { command, description: "Probe" } }] },
  });
  const result = (content, id = "t1") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] } });
  const output = (pids = 10, creds = 0, write = "Read-only file system") =>
    `Exit code 0\ntouch: cannot touch '/usr/p': ${write}\nprobe pids ${pids} creds ${creds}`;
  const probe = [use(PROBE), result(output())];

  // The probe: its verdict, and when there is none yet.
  assert.deepEqual(probeVerdict([init({}), ...probe]), { problem: null, pids: 10, creds: 0 });
  assert.equal(probeVerdict([init({})]), undefined);
  assert.equal(probeVerdict([init({}), use(PROBE)]), undefined);
  assert.equal(probeVerdict([init({}), use(` ${PROBE.replaceAll(" ", "  ")}\n`), result([{ type: "text", text: output() }])]).problem, null);
  for (const [content, problem] of [
    [output(19), null],
    [output(10, 0, "Permission denied"), "probe-write"],
    [output(20), "probe-pids"],
    [output(212), "probe-pids"],
    [output(10, 1), "probe-credential"],
    ["Permission to use Bash has been denied.", "probe-output"],
    [output().replace("creds 0", "creds"), "probe-output"],
    [undefined, "probe-output"],
  ]) {
    assert.equal(probeVerdict([init({}), use(PROBE), result(content)]).problem, problem, String(content));
  }
  // The first call must be the probe, after a passing init, whatever its result says.
  assert.equal(probeVerdict([init({}), use("cat pages/00001.txt"), result(output())]).problem, "probe-command");
  assert.equal(probeVerdict([init({}), use(`${PROBE}; cat pages/00001.txt`), result(output())]).problem, "probe-command");
  assert.equal(probeVerdict([init({}), use(PROBE, "t1", "Read"), result(output())]).problem, "probe-command");
  assert.equal(probeVerdict([init({}), use(PROBE, 7), result(output(), 7)]).problem, "probe-command");
  assert.equal(probeVerdict([use(PROBE), init({}), result(output())]).problem, "no-init");
  assert.equal(probeVerdict([init({ tools: ["Bash", "Read"] }), ...probe]).problem, "tools");
  // Called side by side: only the probe's own result decides.
  const both = {
    type: "assistant",
    message: { content: [use(PROBE).message.content[0], { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls pages" } }] },
  };
  assert.equal(probeVerdict([init({}), both, result(output(), "t2"), result(output(212))]).problem, "probe-pids");
  assert.equal(probeVerdict([init({}), both, result(output(212), "t2"), result(output())]).problem, null);
  assert.match(PROMPT, /^Your first Bash call, before you read any file, is this command, exactly and alone: touch \/usr\/p; /);
  assert.ok(PROMPT.includes(PROBE));

  assert.equal(sessionProblem([init({}), ...probe]), null);
  assert.equal(sessionProblem([init({ tools: ["Bash", "EndConversation"] }), ...probe]), null);
  assert.equal(sessionProblem([init({ permissionMode: undefined, plugins: [] }), ...probe]), null);
  for (const tool of ["Read", "WebFetch", "Task"]) assert.equal(sessionProblem([init({ tools: ["Bash", tool] }), ...probe]), "tools", tool);
  assert.equal(sessionProblem([init({ tools: undefined }), ...probe]), "tools");
  assert.equal(sessionProblem([init({ mcp_servers: [{ name: "x", status: "connected" }] }), ...probe]), "mcp-servers");
  assert.equal(sessionProblem([init({ mcp_servers: undefined }), ...probe]), "mcp-servers");
  assert.equal(sessionProblem([init({ plugins: [{ name: "p", path: "/p" }] }), ...probe]), "plugins");
  for (const mode of ["auto", "default", "bypassPermissions"]) {
    assert.equal(sessionProblem([init({ permissionMode: mode }), ...probe]), "permission-mode", mode);
  }
  assert.equal(sessionProblem([]), "no-init");
  assert.equal(sessionProblem([{ type: "result", subtype: "success" }]), "no-init");
  assert.equal(sessionProblem([init({})]), "no-probe");
  assert.equal(sessionProblem([init({}), use(PROBE), result(output(10, 0, "Permission denied"))]), "probe-write");
  // Every init counts, not only the first, also one after the probe.
  assert.equal(sessionProblem([init({}), init({ tools: ["Bash", "Read"] }), ...probe]), "tools");
  assert.equal(sessionProblem([init({}), ...probe, init({ tools: ["Bash", "Read"] })]), "tools");

  // The watcher, end to end: the kill command runs on a failing probe or a
  // stream that ends before it, and the transcript is the stream as it came
  // (on a failure, up to the verdict at least).
  const watched = (events) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-test-"));
    try {
      const input = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      const marker = path.join(dir, "killed");
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--watch", path.join(dir, "t.jsonl"), process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], '')", marker],
        { input, encoding: "utf8" },
      );
      const kept = fs.readFileSync(path.join(dir, "t.jsonl"), "utf8");
      return { code: run.status, killed: fs.existsSync(marker), kept: input.startsWith(kept) ? kept.length : -1, all: input.length, said: run.stdout.trim() };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const done = { type: "result", subtype: "success", num_turns: 3 };
  const passed = watched([init({}), ...probe, use("python3 x.py", "t3"), done]);
  assert.deepEqual(passed, { code: 0, killed: false, kept: passed.all, all: passed.all, said: "Probe: ok: 10 processes, 0 credential lines" });
  for (const [events, why, upTo] of [
    [[init({}), use(PROBE), result(output(212)), done], "probe-pids: 212 processes, 0 credential lines", 3],
    [[init({}), use("cat pages/00001.txt"), result(output()), done], "probe-command", 2],
    [[init({ mcp_servers: [{ name: "x" }] }), ...probe], "mcp-servers", 1],
    [[init({}), done], "no-probe", 2],
    [[], "no-probe", 0],
  ]) {
    const run = watched(events);
    const verdictAt = events.slice(0, upTo).map((event) => `${JSON.stringify(event)}\n`).join("").length;
    assert.equal(run.said, `::error::The agent session failed its probe (${why}) and was stopped: its result is not used.`);
    assert.deepEqual([run.code, run.killed, run.kept >= verdictAt], [1, true, true], why);
  }

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
  console.log("check-session.mjs selftest: ok (probe, watcher, session check, counts-only summary, agent/settings.json)");
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "--selftest") {
  selftest();
} else if (mode === "--prompt") {
  console.log(PROMPT);
} else if (mode === "--watch" && args.length >= 2) {
  watch(args[0], args.slice(1));
} else {
  const [transcript, resultFile] = [mode, args[0]];
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
