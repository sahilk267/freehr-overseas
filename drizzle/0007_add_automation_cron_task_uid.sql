ALTER TABLE `workspaceSettings` ADD `automationCronTaskUid` varchar(65);--> statement-breakpoint
CREATE INDEX `workspace_automation_cron_idx` ON `workspaceSettings` (`automationCronTaskUid`);
