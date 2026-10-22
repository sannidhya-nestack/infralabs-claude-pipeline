#!/usr/bin/env bash
# The parent sweep (parent.yml). The platform dispatches each new PDF itself;
# this re-dispatches the PENDING github-actions jobs that are due again:
#   - no marker, or a platform dispatch that failed ("gh-dispatched:0")
#   - a dispatch older than 15 min with no run for it (lost)
#   - a Claude deferral whose reset time has passed ("claude-deferred:<t>")
# Env: DATABASE_URL, GH_TOKEN, GH_REPO, REF, LANES. Prints counts only.
set -euo pipefail
source "$(dirname "$0")/db.sh"

[[ "${LANES:-}" =~ ^[0-9]{1,2}$ ]] && [ "$LANES" -ge 1 ] || { echo "::error::LANES must be a number from 1 to 99"; exit 1; }

# Uploads that already have a queued or running child (run-name "invoice <id>").
# ponytail: the newest 300 runs; more than that waiting at once would also overflow
# the lane queues (100 each), and a missed one only costs a duplicate that exits at its claim.
active=$(gh run list --workflow process-invoice.yml --limit 300 --json displayTitle,status \
  --jq '.[] | select(.status != "completed") | .displayTitle | select(startswith("invoice ")) | ltrimstr("invoice ")')

due=$(db_query "SELECT j.uploadId FROM ProcessingJob j JOIN Upload u ON u.id = j.uploadId
WHERE u.status = 'processing' AND j.status = 'PENDING' AND j.kind = 'github-actions'
  AND (j.errorMessage IS NULL
    OR (j.errorMessage LIKE 'gh-dispatched:%' AND CAST(SUBSTRING(j.errorMessage, 15) AS UNSIGNED) < UNIX_TIMESTAMP() - 900)
    OR (j.errorMessage LIKE 'claude-deferred:%' AND CAST(SUBSTRING(j.errorMessage, 17) AS UNSIGNED) <= UNIX_TIMESTAMP()))
ORDER BY u.createdAt LIMIT 20")

found=0 busy=0 claimed=0 dispatched=0 failed=0 invalid=0
for id in $due; do
  found=$((found + 1))
  if ! valid_id "$id"; then invalid=$((invalid + 1)); continue; fi
  if grep -qxF "$id" <<<"$active"; then busy=$((busy + 1)); continue; fi
  # Mark first and dispatch only if this sweep changed the row: 0 means a child
  # claimed it since the select.
  won=$(db_query "UPDATE ProcessingJob SET errorMessage = CONCAT('gh-dispatched:', UNIX_TIMESTAMP()), updatedAt = UTC_TIMESTAMP(3)
WHERE uploadId = '$id' AND status = 'PENDING' AND kind = 'github-actions'; SELECT ROW_COUNT();")
  if [ "$won" != 1 ]; then claimed=$((claimed + 1)); continue; fi
  lane=$(( $(printf '%s' "$id" | cksum | cut -d' ' -f1) % LANES ))
  if gh workflow run process-invoice.yml --ref "$REF" -f upload_id="$id" -f lane="$lane" >/dev/null; then
    dispatched=$((dispatched + 1))
  else
    failed=$((failed + 1))
  fi
done

{
  echo "| Due | Already queued or running | Claimed meanwhile | Dispatched | Dispatch failed | Invalid id |"
  echo "|---|---|---|---|---|---|"
  echo "| $found | $busy | $claimed | $dispatched | $failed | $invalid |"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$failed" -gt 0 ] || [ "$invalid" -gt 0 ]; then
  echo "::error::$failed dispatch(es) failed, $invalid invalid id(s). Failed dispatches are due again in 15 min."
  exit 1
fi
