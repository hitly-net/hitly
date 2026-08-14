ALTER TABLE `projects` MODIFY `plugin` enum('mastra','n8n','langgraph','temporal','hermes','http') NOT NULL;
--> statement-breakpoint
ALTER TABLE `approvals` MODIFY `plugin` enum('mastra','n8n','langgraph','temporal','hermes','http') NOT NULL;
--> statement-breakpoint
UPDATE `projects` SET `plugin` = 'http' WHERE `plugin` = 'n8n';
--> statement-breakpoint
UPDATE `approvals` SET `plugin` = 'http' WHERE `plugin` = 'n8n';
--> statement-breakpoint
ALTER TABLE `projects` MODIFY `plugin` enum('mastra','http','langgraph','temporal','hermes') NOT NULL;
--> statement-breakpoint
ALTER TABLE `approvals` MODIFY `plugin` enum('mastra','http','langgraph','temporal','hermes') NOT NULL;
