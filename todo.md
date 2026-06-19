# TNT Bridge — Xentral to Osapiens TODO

## Phase 1 — Schema, Design System & Dependencies
- [x] Install qrcode and qrcode types packages
- [x] Define database schema: delivery_notes, delivery_note_items tables
- [x] Apply database migration SQL
- [x] Set global design tokens in index.css (dark warehouse theme, high-contrast)
- [x] Configure Google Fonts in index.html

## Phase 2 — Backend
- [x] Product cache service (in-memory, Category 95000, with refresh)
- [x] Xentral data mapper (delivery note → Osapiens SalesOrder JSON)
- [x] QR code generator utility
- [x] Public webhook endpoint POST /api/webhook/xentral
- [x] tRPC: orders.list procedure (paginated, with status)
- [x] tRPC: orders.getById procedure
- [x] tRPC: orders.retry procedure (re-fetch and remap)
- [x] tRPC: products.sync procedure (admin: refresh cache)
- [x] tRPC: products.count procedure (return cached count)
- [x] Role-based access: warehouse sees QR only; admin sees full log

## Phase 3 — Frontend
- [x] Dark warehouse theme with high-contrast status indicators
- [x] OrderList page: cards with Ready/Error/Pending status badges, search/filter tabs
- [x] OrderDetail page: QR code display + data verification panel
- [x] Error state in detail view with missing-field message and Retry / Re-fetch button
- [x] Sync Products button in header with confirmation toast
- [x] Responsive, touch-friendly layout (tablet/mobile optimised)
- [x] App.tsx routes wired (/ and /orders/:id)

## Phase 4 — Tests & Delivery
- [x] Vitest: data mapper unit tests (8 tests)
- [x] Vitest: QR generator tests (2 tests)
- [x] Vitest: auth.logout test (1 test)
- [x] Run pnpm test — all 12 tests pass
- [x] Save checkpoint

## Phase 5 — Fetch Orders (Active Polling)
- [x] Add server-side fetchDeliveryNotesFromXentral() in xentralPoller.ts
- [x] Add tRPC procedure: orders.fetchFromXentral (admin only)
- [x] Replace "Sync Products" header button with "Fetch Orders" primary button
- [x] Keep product cache refresh as a small secondary icon button
- [x] Show count of newly imported orders in toast after fetch
- [x] Update Vitest tests for the new poller logic

## Phase 6 — EOID Fix & Order Filtering

- [ ] Check dataMapper.ts for the exact free field name being looked up for EOID
- [ ] Add debug logging to capture actual free field names from Xentral API response
- [ ] Fix EOID free field name lookup to match actual Xentral field name
- [ ] Hide orders with "Missing EOID" error from the default All/Ready/Pending views (only visible in Error tab)
- [ ] Ensure the Error tab still shows them with a clear explanation

## Phase 7 — Order Management (Delete)

- [x] Add deleteDeliveryNote(id) DB helper in db.ts
- [x] Add bulkDeleteByStatus(status) DB helper in db.ts
- [x] Add tRPC procedure: orders.delete (admin only, single order)
- [x] Add tRPC procedure: orders.bulkDelete (admin only, by status filter)
- [x] Add individual delete button on each order card in Orders.tsx
- [x] Add "Clear Error Orders" bulk action button in the Error tab header
- [x] Confirm dialog before bulk delete
- [x] Update Vitest tests for new procedures

## Phase 8 — Order Number Fix & Smarter Fetch

- [ ] Fix xentralNumber: store documentNumber (e.g. "LN-2026-00123") not the internal Xentral ID
- [ ] Add salesOrderNumber field to schema to store the linked sales order document number
- [ ] Add "Fetch by document number" input to Orders page header so user can fetch a specific delivery note by its Xentral document number
- [ ] Also add option to skip already-fetched notes (only fetch new ones) to speed up bulk fetch
- [ ] Update UI labels: show both delivery note number and sales order number where available

## Phase 9 — Tobacco Pre-Filter & Performance

- [ ] At list level, check if positions are included in V3 list response — if yes, filter before fetching detail
- [ ] If positions not in list response, fetch V3 detail for each note but check positions first before running full mapping pipeline — skip notes with zero tobacco positions
- [ ] Add skip-already-fetched optimisation: if xentralId already in DB as "ready", skip detail fetch entirely
- [ ] Fix order number: documentNumber fix already applied in webhookProcessor.ts and dataMapper.ts
- [ ] Add fetch-by-document-number input to Orders header for targeted single-order fetch

## Phase 10 — SKU Prefix Filter & Document Number Search

- [ ] Update isTobaccoProduct() in productCache.ts to also match product numbers starting with "95"
- [ ] Update filterTobaccoPositions() in webhookProcessor.ts to use both cache ID check AND SKU prefix "95" check
- [ ] Update xentralPoller.ts hasTobacco check to use both cache ID AND SKU prefix "95"
- [ ] Add document number search input to Orders page header for targeted single-order fetch
- [ ] Update fetch toast messages to show tobaccoFound count

## Phase 11 — Sales Order Number Reference Field
- [ ] Add salesOrderNumber column to delivery_notes table in drizzle/schema.ts
- [x] Generate and apply migration SQL via webdev_execute_sql
- [ ] Extract salesOrderNumber from V3 detail response in xentralPoller.ts
- [ ] Pass salesOrderNumber through webhookProcessor and upsertDeliveryNote in db.ts
- [ ] Display sales order number in order cards and detail view in Orders.tsx
- [ ] Include salesOrderNumber in the search index so users can search by order number
- [ ] Update Vitest tests for the new field

## Phase 12 — QR Code Format Fix (Osapiens Dispatch OSAPV1EDP)

- [x] Add `fid` column to `delivery_notes` table in drizzle/schema.ts (customer facility ID from Xentral freifeld6)
- [x] Add `dispatchQrText` column to `delivery_notes` table (plain text QR string)
- [x] Generate and apply migration SQL via webdev_execute_sql
- [x] Fetch FID from Xentral `freifeld6` in xentralPoller.ts alongside EOID
- [x] Update dataMapper.ts: add FID to MappingResult, pass through to DB
- [x] Update dataMapper.ts: change QR data to use GTIN (ean) as product code, not productNumber
- [x] Rewrite qrGenerator.ts: produce OSAPV1EDP semicolon-delimited plain text instead of JSON
- [x] Update webhookProcessor.ts: store dispatchQrText and fid in DB
- [x] Update db.ts: include fid and dispatchQrText in upsertDeliveryNote and updateDeliveryNoteStatus
- [x] Update routers.ts: expose fid and dispatchQrText in getById response
- [x] Update OrderDetail.tsx: show FID field in customer section
- [x] Update OrderDetail.tsx: show product GTIN in items table
- [x] Update Vitest tests: update tnt.test.ts for new dispatch QR format

## Phase 13 — Order Number Fix & Sales Order Data (Payment, Delivery, Value)

- [x] Fix order number display: ensure xentralNumber stores the delivery note documentNumber (e.g. LN-2026-00123), not the internal ID
- [x] Add salesOrderId column to delivery_notes to store the Xentral sales order ID for API lookup
- [x] Add paymentMethod, deliveryMethod, orderValue, orderCurrency columns to delivery_notes
- [x] Apply migration SQL via webdev_execute_sql
- [x] In xentralPoller.ts: after fetching delivery note detail, fetch the linked sales order via V3 API to extract paymentMethod, deliveryMethod, and line item values
- [x] Pass paymentMethod, deliveryMethod, orderValue, orderCurrency through webhookProcessor to DB
- [x] Add paymentMethod and deliveryMethod to QR code payload (fields 13 and 14, currently empty)
- [x] Update OrderDetail.tsx: show payment method, delivery method, and order value in the UI
- [x] Update Vitest tests for new fields

## Phase 14 — Osapiens Dispatch Event API Integration

- [x] Read Osapiens spec Section 4.8 to understand dispatch event payload structure
- [x] Add `sentToOsapiens` (boolean), `sentAt` (timestamp), `osapiensSendError` (text) columns to delivery_notes
- [x] Apply migration SQL via webdev_execute_sql
- [x] Build `server/osapiensSender.ts`: construct EPCIS dispatch event payload and POST to Osapiens API
- [x] Add placeholder secrets: OSAPIENS_API_URL, OSAPIENS_USERNAME, OSAPIENS_PASSWORD, OSAPIENS_CUSTOMER, OSAPIENS_APPLICATION, OSAPIENS_OUR_EOID, OSAPIENS_OUR_FID
- [x] Add tRPC procedure: `orders.sendToOsapiens` (admin only) — calls osapiensSender and updates DB status
- [x] Add "Send to Osapiens" button on each order card in Orders.tsx (list view)
- [x] Add "Send to Osapiens" button on OrderDetail.tsx (detail view)
- [x] Show "Sent" badge / timestamp on order cards and detail view when sentToOsapiens = true
- [x] Show error message on card/detail if osapiensSendError is set
- [x] Update Vitest tests for new procedure and sender logic

## Phase 15 — Osapiens Sales Order API (Correct Integration)

- [x] Discover correct Osapiens customer ID: trulodistro (from portal URL)
- [x] Identify correct API user: api@trulodistro.com (dedicated API user with API Admin role)
- [x] Update OSAPIENS_USERNAME secret to api@trulodistro.com
- [x] Register TRULO GmbH scanning location in Osapiens portal (FID: QCBDR<1DE538913929428)
- [x] Rewrite osapiensSender.ts: replace dispatch event (capture-json) with Sales Order (masterdata-v1)
- [x] Add ensureDeliveryPoint(): auto-creates customer Organisation + DeliveryPoint before SalesOrder
- [x] Remove non-spec fields (DeliveryMethod, PaymentMethod, OrderValue) from SalesOrder payload
- [x] End-to-end test: Sales Order created successfully in Osapiens live system (HTTP 200)
- [x] All 33 Vitest tests passing
