# Phase 15 — monitoring systemd templates (DO NOT ENABLE YET)

These units drive the read-only monitoring collectors on the DigitalOcean
droplet. They are **templates only** — do NOT `systemctl enable`/`start` them
until Phase 15 is validated and activation is explicitly approved.

Suggested cadence (per DATASET Phase 15):
- `brawlranks-monitoring-health.timer`   — operational health snapshot every 5 min
- `brawlranks-monitoring-evaluate.timer`  — alert evaluation every 5 min
- `brawlranks-monitoring-capacity.timer`  — capacity snapshot daily

The health/evaluate collectors and the capacity collector all run
`scripts/monitoring/monitor.ts`, which is read-only against operational tables
and writes only monitoring rows. No unit performs any destructive action.

Install (when approved):
```bash
sudo cp ops/monitoring/*.service ops/monitoring/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
# then, ONLY after validation + approval:
# sudo systemctl enable --now brawlranks-monitoring-health.timer
# sudo systemctl enable --now brawlranks-monitoring-evaluate.timer
# sudo systemctl enable --now brawlranks-monitoring-capacity.timer
```
The monitoring env file (`/etc/brawlranks-worker/monitoring.env`) supplies the
same writer-role DB vars as the other workers plus optional
`MON_DB_CAPACITY_LIMIT_BYTES`, `MON_BACKUP_AGE_SECONDS`,
`MON_RESTORE_TEST_AGE_SECONDS`, and any `MON_*` threshold overrides.
