#!/usr/bin/env bash
# Waits for an artifact of another run of this repo, then downloads and unzips
# it (agent.yml and process-invoice.yml on branch agent):
#
#   bash scripts/wait-artifact.sh <run id> <name> <minutes> <dir> <max bytes>
#
# Polls every 15 s for up to <minutes>. Once that run has completed it looks one
# more time, so a last-second upload is not missed, then stops. An artifact over
# <max bytes> is refused unread. <dir> must not exist yet.
# Env: GH_TOKEN, GH_REPO. Prints ids and counts only.
set -euo pipefail
run=$1 name=$2 minutes=$3 dir=$4 max=$5
[[ "$run" =~ ^[0-9]{1,20}$ ]] || { echo "::error::not a run id"; exit 1; }
[[ "$name" =~ ^[a-z][a-z-]{0,39}$ && "$minutes" =~ ^[1-9][0-9]{0,2}$ && "$max" =~ ^[1-9][0-9]{0,11}$ ]] ||
  { echo "::error::usage: wait-artifact.sh <run id> <name> <minutes> <dir> <max bytes>"; exit 1; }

api="repos/$GH_REPO/actions"
deadline=$((SECONDS + minutes * 60)) fails=0
while :; do
  # The run's state first: an artifact listed after it completed is its last.
  if ended=$(gh api "$api/runs/$run" --jq '.status == "completed"' 2> /dev/null) &&
    found=$(gh api "$api/runs/$run/artifacts?name=$name" \
      --jq '.artifacts[] | select(.expired | not) | "\(.id) \(.size_in_bytes)"' 2> /dev/null); then
    fails=0
    [ -z "$found" ] || break
    [ "$ended" != true ] || { echo "::warning::Run $run ended without $name."; exit 1; }
  else
    fails=$((fails + 1))
    [ "$fails" -lt 8 ] || { echo "::warning::The GitHub API failed 8 times in a row."; exit 1; }
  fi
  [ "$SECONDS" -lt "$deadline" ] || { echo "::warning::No $name from run $run in $minutes min."; exit 1; }
  sleep 15
done

# Names are unique within a run: the first line is the one.
read -r id size <<< "$found"
[[ "$id" =~ ^[0-9]{1,20}$ && "$size" =~ ^[0-9]{1,12}$ ]] || { echo "::error::unexpected artifact listing"; exit 1; }
[ "$size" -le "$max" ] || { echo "::error::$name is $size bytes, over $max"; exit 1; }
mkdir "$dir"
gh api "$api/artifacts/$id/zip" > "$dir.zip"
[ "$(stat -c %s "$dir.zip")" -le "$max" ] || { echo "::error::$name download is over $max bytes"; exit 1; }
unzip -q "$dir.zip" -d "$dir"
rm -f "$dir.zip"
echo "$name: artifact $id from run $run, $size bytes"
