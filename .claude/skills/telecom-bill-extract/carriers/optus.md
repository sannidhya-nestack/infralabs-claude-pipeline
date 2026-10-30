# Optus (Amdocs "Dox PDF") mobile bills - parser `optus`

- Fingerprint: page 1 prints `Optus Billing Services`.
- Page 1 targets: `New Charges` (inc GST), `Recurring Charges`, `Usage Charges`, `Other Charges
  and Credits`, `GST`, plus `Invoice No:`, `ACCOUNT NUMBER`, `Issue Date:`, `Invoice Period:`.
- Account-level charges: `Total Account Charges` in the first ~10 pages (Account Charge
  Breakdown); must equal page 1's `Other Charges and Credits`.
- Charge Summary page: per-plan quantities, the expected service count (may differ slightly
  from the parsed count; the totals are the hard check).
- Service block: `Service Details`, then `<service no>  Total Charges (Ex GST)  <amount>`, plan
  line, user name line, then `Recurring Charges` / `Usage Charges` sections, each with a
  `... Total <amount>` line and its items.
- `Service Details (continued)` repeats the header on the next page: same service, not a new one.
- Service headers can be indented (`^\s*`): an unanchored regex silently dropped 5 services ($409.10).
- Lines prefixed `*` are GST-free (roaming).
- `Charge Types`, `Allowances` and `Usage Details` end a charge section. Usage Details (call and
  data records) are about 95% of the pages and are skipped.
- A 23,123-page bill: pdftotext about 35 s on a hosted runner, 165 MB of text.
