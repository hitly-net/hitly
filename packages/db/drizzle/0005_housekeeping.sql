CREATE TABLE `housekeeping_jobs` (
	`id` varchar(64) NOT NULL,
	`schedule` enum('hourly','daily','weekly') NOT NULL,
	`last_started_at` timestamp(3),
	`last_finished_at` timestamp(3),
	`last_error` text,
	`last_result` json,
	CONSTRAINT `housekeeping_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `approvals_workspace_status_updated_idx` ON `approvals` (`workspace_id`,`status`,`updated_at`);
