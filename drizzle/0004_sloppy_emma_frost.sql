ALTER TABLE `delivery_notes` ADD `salesOrderId` varchar(128);--> statement-breakpoint
ALTER TABLE `delivery_notes` ADD `paymentMethod` varchar(256);--> statement-breakpoint
ALTER TABLE `delivery_notes` ADD `deliveryMethod` varchar(256);--> statement-breakpoint
ALTER TABLE `delivery_notes` ADD `orderValue` decimal(12,2);--> statement-breakpoint
ALTER TABLE `delivery_notes` ADD `orderCurrency` varchar(8);