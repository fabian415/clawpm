-- Per-team default notification email recipients (was a single global setting)
ALTER TABLE teams ADD COLUMN IF NOT EXISTS notification_emails TEXT;
