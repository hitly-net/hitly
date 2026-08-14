ALTER TABLE `projects` MODIFY `plugin` enum('mastra','n8n','langgraph','temporal','hermes') NOT NULL;
--> statement-breakpoint
ALTER TABLE `approvals` MODIFY `plugin` enum('mastra','n8n','langgraph','temporal','hermes') NOT NULL;
