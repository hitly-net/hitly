CREATE TABLE `user_devices` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`expo_push_token` varchar(255) NOT NULL,
	`platform` enum('ios','android') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_devices_expo_push_token_unique` UNIQUE(`expo_push_token`)
);
--> statement-breakpoint
ALTER TABLE `user_devices` ADD CONSTRAINT `user_devices_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `user_devices_user_id_idx` ON `user_devices` (`user_id`);
