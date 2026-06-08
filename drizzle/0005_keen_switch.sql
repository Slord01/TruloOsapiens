ALTER TABLE `delivery_notes` ADD `sentToOsapiens` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `delivery_notes` ADD `sentToOsapiensAt` bigint;--> statement-breakpoint
ALTER TABLE `delivery_notes` ADD `osapiensSendError` text;