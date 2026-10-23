#!/usr/bin/env bash
# The agent's OS jail (agent.yml, step "Jail"), run as root on a fresh hosted
# runner before any bill arrives: its own user, a closed runner home, egress for
# that user only to Anthropic's API, and a self-test that proves it on every run.
# It does not lean on Claude Code's sandbox or settings: -p ignores a settings
# file that fails validation without a word, and this still holds then.
#
#   sudo bash scripts/agent-jail.sh <runner home> <pid of a runner-owned shell> <dir of node and srt>
#
# Linux only. Any failure ends the job: no agent runs, the host reads the bill with vision.
set -euo pipefail
home=$1 runner_pid=$2 bin=$3
[[ -d "$home" && "$runner_pid" =~ ^[0-9]{1,10}$ && -x "$bin/node" && -x "$bin/srt" ]] ||
  { echo "::error::usage: agent-jail.sh <runner home> <runner pid> <dir of node and srt>"; exit 1; }
settings=$(realpath "$(dirname "$0")/../agent/settings.json")
cd /

# No home skeleton (the CLI sources ~/.bashrc at session start), no sudo, no docker group.
useradd -M -U -s /bin/bash agent
install -d -o agent -g agent -m 700 /home/agent /home/agent/work /home/agent/work/out
# The runner install, _work, _temp, the keys and the transcript all live under it.
chmod 700 "$home"
install -d -m 755 /opt/agent
install -m 644 "$settings" /opt/agent/settings.json

# Ubuntu 24.04 can bar unprivileged user namespaces, which bwrap needs.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  cat > /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
EOF
  apparmor_parser -r /etc/apparmor.d/bwrap
fi

# Local daemons go online for anyone who reaches their socket (resolved's DNS
# over D-Bus, snapd's store search), and the sandbox's seccomp filter that stops
# that is optional: the CLI only warns when it is missing. So every socket is
# closed to the agent here, whatever the sandbox does.
# ponytail: the sockets that exist now; one a daemon makes later is open again.
find /run /tmp /var/tmp /dev/shm -type s -exec setfacl -m u:agent:--- {} + 2>/dev/null || true

# The API host, pinned after a range check, so the agent needs no DNS.
ip=$(getent ahostsv4 api.anthropic.com | awk 'NR == 1 { print $1 }')
[[ "$ip" =~ ^160\.79\.10[45]\.[0-9]{1,3}$ ]] || { echo "::error::api.anthropic.com is not inside 160.79.104.0/23"; exit 1; }
echo "$ip api.anthropic.com" >> /etc/hosts

# The agent's uid may send TCP on lo but port 53 (the sandbox proxy's plumbing,
# not the DNS stub), TCP 443 to Anthropic's published inbound ranges, and nothing
# else: no DNS, no metadata address, no other host.
uid=$(id -u agent)
iptables -w -I OUTPUT 1 -m owner --uid-owner "$uid" -o lo -p tcp ! --dport 53 -j ACCEPT
iptables -w -I OUTPUT 2 -m owner --uid-owner "$uid" -p tcp -d 160.79.104.0/23 --dport 443 -j ACCEPT
iptables -w -I OUTPUT 3 -m owner --uid-owner "$uid" -j REJECT
ip6tables -w -I OUTPUT 1 -m owner --uid-owner "$uid" -o lo -p tcp ! --dport 53 -j ACCEPT
ip6tables -w -I OUTPUT 2 -m owner --uid-owner "$uid" -p tcp -d 2607:6bc0::/48 --dport 443 -j ACCEPT
ip6tables -w -I OUTPUT 3 -m owner --uid-owner "$uid" -j REJECT

# The self-test, as the agent. Explicit ifs: set -e does not act on a "!" command.
[ -r "/proc/$runner_pid/environ" ] || { echo "::error::no process $runner_pid to test against"; exit 1; }
bad=0
must_fail() {
  if sudo -u agent -H "$@" > /dev/null 2>&1; then echo "::error::Jail self-test: the agent can run: $*"; bad=1; fi
}
must_work() {
  if ! sudo -u agent -H "$@" > /dev/null 2>&1; then echo "::error::Jail self-test: the agent cannot run: $*"; bad=1; fi
}
must_fail curl -s --max-time 10 https://example.com
must_fail curl -s --max-time 10 http://169.254.169.254/
must_fail getent hosts example.com
must_fail cat "/proc/$runner_pid/environ"
must_fail ls "$home"
must_fail sudo -n true
must_fail curl -s --max-time 10 --unix-socket /var/run/docker.sock http://localhost/version
must_fail test -w /opt/agent/settings.json
must_work curl -s --max-time 30 -o /dev/null https://api.anthropic.com/
must_work bwrap --ro-bind / / --unshare-net true
open=$({ sudo -u agent find /run /tmp /var/tmp /dev/shm -type s -writable 2> /dev/null || true; } | wc -l)
if [ "$open" != 0 ]; then echo "::error::Jail self-test: the agent can reach $open local socket(s)"; bad=1; fi

# The CLI keeps the credential in its own environment, as the agent, and every
# command it runs is the agent too: what keeps /proc/<cli>/environ from them is
# the sandbox's PID namespace and fresh /proc (bwrap --unshare-pid --proc /proc).
# The env scrub's own /proc isolation is best-effort where unprivileged user
# namespaces are barred, so the sandbox's is proven here, through the runtime the
# CLI embeds: an agent shell with a marker in its environment starts a sandboxed
# command without it, as the CLI does, and that command must run and must not
# find the marker. The "exit" keeps the shell alive as the command's parent.
# ponytail: srt is the standalone sandbox runtime, not the CLI's own copy; both
# pass those bwrap flags today. If they ever part, test through the CLI itself.
marker=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n') err=$(mktemp)
seen=$({ sudo -u agent -H /usr/bin/env -C /home/agent/work PATH="$bin:/usr/bin:/bin" "JAIL_MARKER=$marker" \
  bash -c 'env -u JAIL_MARKER timeout -k 5 120 srt "echo jail-probe; cat /proc/[0-9]*/environ"; exit $?' \
  2> "$err" || true; } | tr '\0' '\n')
pkill -KILL -u agent || true
# srt's own errors only: no bill has arrived yet.
if ! grep -qx jail-probe <<< "$seen"; then echo "::error::Jail self-test: the agent cannot run a sandboxed command"; head -c 2000 "$err"; bad=1; fi
if grep -qF "$marker" <<< "$seen"; then echo "::error::Jail self-test: a sandboxed command can read the environment of the agent process that started it"; bad=1; fi
[ "$bad" = 0 ] || exit 1
echo "Jail self-test: ok"
