ALTER TABLE `workspaceSettings` ADD `scheduleCronTaskUid` varchar(65);--> statement-breakpoint
CREATE INDEX `workspace_schedule_cron_idx` ON `workspaceSettings` (`scheduleCronTaskUid`);