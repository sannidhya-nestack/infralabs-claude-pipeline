#!/usr/bin/env bash
# The parent sweep (parent.yml). The platform dispatches each new PDF itself;
# this re-dispatches the PENDING github-actions jobs that are due again:
#   - no marker, or a platform dispatch that failed ("gh-dispatched:0")
#   - a dispatch older than 15 min with no run for it (lost)
#   - a Claude deferral whose reset time has passed ("claude-deferred:<t>")
# Env: DATABASE_URL, GH_TOKEN, GH_REPO, REF, LANES. Prints counts only.
set -euo pipefail
source "$(dirname "$0")/db.sh"

# No leading zero: bash arithmetic reads "08" as octal.
[[ "${LANES:-}" =~ ^[1-9][0-9]?$ ]] || { echo "::error::LANES must be a number from 1 to 99"; exit 1; }

# Uploads that already have a queued or running child (run-name "invoice <id>").
# ponytail: the newest 300 runs; more than that waiting at once would also overflow
# the lane queues (100 each), and a missed one only costs a duplicate that exits at its claim.
active=$(gh run list --workflow process-invoice.yml --limit 300 --json displayTitle,status \
  --jq '.[] | select(.status != "completed") | .displayTitle | select(startswith("invoice ")) | ltrimstr("invoice ")')

# Due again, as listed above. The select and the mark below both test it.
due_sql="(j.errorMessage IS NULL
    OR (j.errorMessage LIKE 'gh-dispatched:%' AND CAST(SUBSTRING(j.errorMessage, 15) AS UNSIGNED) < UNIX_TIMESTAMP() - 900)
    OR (j.errorMessage LIKE 'claude-deferred:%' AND CAST(SUBSTRING(j.errorMessage, 17) AS UNSIGNED) <= UNIX_TIMESTAMP()))"

# The same window as the run list: busy ones are skipped below, so a backlog of
# queued runs cannot hide a newer lost dispatch.
due=$(db_query "SELECT j.uploadId FROM ProcessingJob j JOIN Upload u ON u.id = j.uploadId
WHERE u.status = 'processing' AND j.status = 'PENDING' AND j.kind = 'github-actions' AND $due_sql
ORDER BY u.createdAt LIMIT 300")

found=$(wc -w <<<"$due") busy=0 changed=0 dispatched=0 failed=0 invalid=0
for id in $due; do
  if ! valid_id "$id"; then invalid=$((invalid + 1)); continue; fi
  if grep -qxF "$id" <<<"$active"; then busy=$((busy + 1)); continue; fi
  # Mark first and dispatch only if this sweep changed the row: 0 means it is no
  # longer due (a child claimed it, deferred it again, or the platform re-sent it).
  # IGNORE: strict mode turns the CAST warning on a malformed marker into an
  # error in an UPDATE (the select only warns), and one such row would stop
  # every sweep here.
  won=$(db_query "UPDATE IGNORE ProcessingJob j SET j.errorMessage = CONCAT('gh-dispatched:', UNIX_TIMESTAMP()), j.updatedAt = UTC_TIMESTAMP(3)
WHERE j.uploadId = '$id' AND j.status = 'PENDING' AND j.kind = 'github-actions' AND $due_sql; SELECT ROW_COUNT();")
  if [ "$won" != 1 ]; then changed=$((changed + 1)); continue; fi
  # The platform's lane (githubLane in enqueue-invoice.ts): the first 4 bytes of
  # sha1(id), big-endian, so a re-dispatch queues behind the same bill.
  lane=$(( 16#$(printf '%s' "$id" | sha1sum | cut -c1-8) % LANES ))
  if gh workflow run process-invoice.yml --ref "$REF" -f upload_id="$id" -f lane="$lane" >/dev/null; then
    dispatched=$((dispatched + 1))
    # ponytail: 20 a sweep; the next sweep, 30 min later, takes the rest.
    [ "$dispatched" -lt 20 ] || break
  else
    failed=$((failed + 1))
  fi
done
left=$((found - busy - changed - dispatched - failed - invalid))

{
  echo "| Due | Already queued or running | Changed meanwhile | Dispatched | Dispatch failed | Invalid id | Left for the next sweep |"
  echo "|---|---|---|---|---|---|---|"
  echo "| $found | $busy | $changed | $dispatched | $failed | $invalid | $left |"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$failed" -gt 0 ] || [ "$invalid" -gt 0 ]; then
  echo "::error::$failed dispatch(es) failed, $invalid invalid id(s). Failed dispatches are due again in 15 min."
  exit 1
fi
