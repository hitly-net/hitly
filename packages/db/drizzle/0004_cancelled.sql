ALTER TABLE `approvals` MODIFY `status` enum('pending','decided','expired','failed_resume','cancelled') NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE `decision_records` MODIFY `decision` enum('accept','reject','edit','respond','ignore','cancel') NOT NULL;
