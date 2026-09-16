CREATE TABLE `chat_requests` (
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`request_text` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text DEFAULT 'received' NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `chat_requests_state` ON `chat_requests` (`owner`,`state`,`created_at`);--> statement-breakpoint
ALTER TABLE `operation_effects` ADD `before_payload` text;--> statement-breakpoint
ALTER TABLE `operation_effects` ADD `undo_scope` text;