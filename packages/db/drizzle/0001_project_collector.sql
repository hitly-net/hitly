DELETE FROM `decision_records`;
--> statement-breakpoint
DELETE FROM `approvals`;
--> statement-breakpoint
ALTER TABLE `approvals` DROP FOREIGN KEY `approvals_connection_id_connections_id_fk`;
--> statement-breakpoint
ALTER TABLE `approvals` DROP COLUMN `connection_id`;
--> statement-breakpoint
DROP TABLE `connections`;
--> statement-breakpoint
DROP TABLE `api_keys`;
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`role` enum('owner','admin','member') NOT NULL DEFAULT 'member',
	`invited_by_user_id` varchar(36),
	`accepted_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `invites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`plugin` enum('mastra','n8n','langgraph','temporal') NOT NULL,
	`credentials` json NOT NULL,
	`default_assignee_user_id` varchar(36),
	`default_sla_minutes` varchar(16) NOT NULL DEFAULT '60',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_memberships` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`role` enum('admin','user','reader') NOT NULL DEFAULT 'user',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `project_memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_memberships_project_user_idx` UNIQUE(`project_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `project_api_keys` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`hashed_key` varchar(255) NOT NULL,
	`prefix` varchar(32) NOT NULL,
	`last_used_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `project_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_api_keys_hashed_key_unique` UNIQUE(`hashed_key`)
);
--> statement-breakpoint
CREATE TABLE `project_rules` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`priority` int NOT NULL DEFAULT 100,
	`match` json NOT NULL,
	`actions` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `project_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_channels` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`type` enum('email','slack','telegram') NOT NULL,
	`config` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `project_channels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_events` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`approval_id` varchar(36),
	`level` varchar(16) NOT NULL DEFAULT 'info',
	`type` varchar(64) NOT NULL,
	`message` text NOT NULL,
	`payload` json NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `project_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `approvals` ADD `project_id` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `approvals` ADD `assigned_user_id` varchar(36);
--> statement-breakpoint
ALTER TABLE `approvals` ADD `idempotency_key` varchar(255);
--> statement-breakpoint
ALTER TABLE `invites` ADD CONSTRAINT `invites_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `invites` ADD CONSTRAINT `invites_invited_by_user_id_users_id_fk` FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_default_assignee_user_id_users_id_fk` FOREIGN KEY (`default_assignee_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_memberships` ADD CONSTRAINT `project_memberships_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_memberships` ADD CONSTRAINT `project_memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_api_keys` ADD CONSTRAINT `project_api_keys_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_rules` ADD CONSTRAINT `project_rules_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_channels` ADD CONSTRAINT `project_channels_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_events` ADD CONSTRAINT `project_events_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_assigned_user_id_users_id_fk` FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `invites_workspace_idx` ON `invites` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `invites_email_idx` ON `invites` (`email`);
--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `projects` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `project_api_keys_project_idx` ON `project_api_keys` (`project_id`);
--> statement-breakpoint
CREATE INDEX `project_rules_project_idx` ON `project_rules` (`project_id`);
--> statement-breakpoint
CREATE INDEX `project_channels_project_idx` ON `project_channels` (`project_id`);
--> statement-breakpoint
CREATE INDEX `project_events_project_idx` ON `project_events` (`project_id`);
--> statement-breakpoint
CREATE INDEX `project_events_approval_idx` ON `project_events` (`approval_id`);
--> statement-breakpoint
CREATE INDEX `project_events_created_at_idx` ON `project_events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `approvals_project_status_idx` ON `approvals` (`project_id`,`status`);
--> statement-breakpoint
CREATE INDEX `approvals_project_idempotency_idx` ON `approvals` (`project_id`,`idempotency_key`);
