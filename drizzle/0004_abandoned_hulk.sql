ALTER TABLE `interviews` MODIFY COLUMN `calendarProvider` varchar(64) NOT NULL DEFAULT 'ics';--> statement-breakpoint
ALTER TABLE `interviews` ADD `calendarSequence` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `interviews` ADD `calendarStatus` enum('tentative','confirmed','cancelled') DEFAULT 'tentative' NOT NULL;--> statement-breakpoint
ALTER TABLE `interviews` ADD `reminderAt` timestamp;