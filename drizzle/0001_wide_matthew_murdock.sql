CREATE TABLE `delivery_note_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deliveryNoteId` int NOT NULL,
	`productId` varchar(128),
	`productNumber` varchar(256),
	`productName` varchar(512),
	`ean` varchar(64),
	`quantity` decimal(12,3),
	`unit` varchar(32),
	`unitPrice` decimal(12,4),
	`currency` varchar(8),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `delivery_note_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`xentralId` varchar(128) NOT NULL,
	`xentralNumber` varchar(128) NOT NULL,
	`customerId` varchar(128),
	`customerName` varchar(512),
	`eoid` varchar(256),
	`addressStreet` varchar(512),
	`addressCity` varchar(256),
	`addressPostalCode` varchar(32),
	`addressCountry` varchar(8),
	`rawPayload` json,
	`osapiensSalesOrder` json,
	`qrCodeDataUrl` text,
	`status` enum('pending','ready','error') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`deliveryDate` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `delivery_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_notes_xentralId_unique` UNIQUE(`xentralId`)
);
