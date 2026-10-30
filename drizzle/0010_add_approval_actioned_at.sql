-- Single-use email authorization was present in the schema but missing from migration history.
ALTER TABLE `approvals` ADD `actionedAt` timestamp NULL;
