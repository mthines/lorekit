-- 00121 — validate memories_version_positive (added NOT VALID by 00120).
--
-- A separate file because each migration runs in ONE transaction: validating in
-- 00120 would scan every row while that transaction still held the ACCESS
-- EXCLUSIVE lock its `add column` took, blocking reads and writes for the scan.
-- In its own transaction, VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE,
-- so reads and writes proceed while it scans. It cannot fail: every pre-00120
-- row reads `version` = 1 from the column default, and every row since has been
-- checked on write.

alter table memories validate constraint memories_version_positive;
