# Parkwise Smart Parking

Parkwise is a local-first parking operations app built with Node.js, Express, SQLite, and a responsive browser UI. It supports multiple parking locations, secure operator accounts, space assignment, reservations, rates by vehicle type, checkout receipts, reports, CSV export, audit history, and database backups. It does not process payments.

## Requirements

- Node.js 20 or newer (Node 24 is supported).
- On Windows, if npm cannot download a prebuilt `better-sqlite3` binary, install Visual Studio Build Tools with **Desktop development with C++**.

## Run on Windows

1. Open this project folder in VS Code.
2. Open a terminal in the folder containing `package.json`.
3. Run `npm install`.
4. Run `npm start`.
5. Browse to `http://localhost:3000`.

Do not open `public\index.html` directly with `file://`; the app requires the API server. SQLite data is stored in `parkwise.sqlite` next to `server.js`.

## First sign-in

On the first launch, create the administrator account in the setup screen. Use a unique username and a strong password of at least 12 characters. Parkwise stores a salted scrypt password hash, not the plaintext password. Administrators can create operator and additional administrator accounts from the Admin page.

Parkwise uses an HttpOnly, SameSite session cookie with a 12-hour lifetime. Sign out when finished. Use HTTPS and a production-grade deployment configuration before exposing the app beyond a trusted local network.

## Deploy on Render

GitHub Pages cannot run the Parkwise Node.js API or SQLite database. This repository includes a Render Blueprint (`render.yaml`) for the full-stack app, including a persistent disk for SQLite.

1. Push this project to a GitHub repository and choose **New > Blueprint** in Render.
2. Connect the repository and create the service from `render.yaml`. A Render Starter web service and persistent disk are configured; check Render's current pricing before provisioning.
3. When prompted for `PARKWISE_SETUP_KEY`, provide a unique, random secret of at least 32 characters. Store it in a password manager. It protects initial administrator setup and must never be committed to GitHub.
4. Wait for the deployment health check to pass, open the Render service URL, and create the administrator account using the setup key.
5. Keep the persistent disk mounted at `/var/data`. Do not remove it or change `PARKWISE_DB_PATH` unless you have backed up and migrated the SQLite data.

The setup key is required for initial administrator creation when `NODE_ENV=production`; subsequent sign-in uses the normal account password. Never upload the local SQLite database, backup files, or customer data to GitHub.

## Parking operations

- **Locations:** Create and switch between parking sites. Each location has its own capacity and spaces.
- **Space map:** View occupied and available spaces, inspect a space's vehicle details, and manually assign an open space at entry.
- **Plate capture:** Camera OCR reads visible plate text in the browser. QR scanning decodes QR values only when they contain a recognized Indian registration format. Always verify OCR results before saving. Camera access requires user permission and HTTPS or localhost.
- **QR parking tickets:** Each vehicle check-in displays a printable ticket with a QR code containing only the registration number. Staff can scan that ticket from Vehicle exit to find the active vehicle and review the fee before confirming checkout.
- **Privacy:** OCR runs in the browser. The OCR worker and English recognition data are downloaded from public CDNs when the OCR feature is used; the camera image is not uploaded by Parkwise.
- **Reservations:** Reserve a vehicle for a future interval, check it in during its reservation window, or cancel it. Unchecked reservations are automatically marked as no-shows after the end time. Reservations do not take payments.
- **Live updates:** The dashboard refreshes parking, history, and reservation data every 15 seconds while the page is visible.
- **Rates:** Set a default hourly rate plus optional rates for Car, Bike, SUV, Scooter, Auto, Van, and Other. Checkout charges each started hour, with a one-hour minimum.
- **History and receipts:** Checkout creates a completed session with the rate charged. Search/filter sessions, paginate history, export CSV, and print a checkout receipt.
- **Reports:** Review revenue, completed sessions, average fee, current and peak occupancy, average stay, and daily revenue.
- **Administration:** Create users with admin/operator roles, inspect the audit log, and download a SQLite backup.
- **Clear all data:** Administrators can permanently clear vehicles, parking history, reservations, locations, and custom rates from Settings. The reset creates a fresh Main Parking location (200 spaces, ₹30/hour) and preserves user accounts, sessions, and audit history. It requires typing `CLEAR ALL DATA`.

## API

All `/api` routes except `/api/health` and `/api/auth/*` require a signed-in user. Administrator-only routes require the admin role. Errors use JSON `{ "error": "..." }`.

- `GET /api/health`
- `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/lots`, `POST /api/lots`, `PUT /api/lots/:id`
- `GET /api/dashboard?lotId=1`
- `GET /api/vehicles?lotId=1`, `POST /api/vehicles`, `POST /api/vehicles/:number/exit?lotId=1`
- `GET /api/tickets/:number/qr`
- `GET /api/history?lotId=1&q=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=100&offset=0`
- `GET /api/reports?lotId=1`
- `GET /api/reservations?lotId=1`, `POST /api/reservations`, `POST /api/reservations/:id/check-in?lotId=1`, `POST /api/reservations/:id/cancel?lotId=1`
- `GET /api/settings?lotId=1`, `PUT /api/settings`
- `GET /api/users`, `POST /api/users`, `GET /api/audit`
- `GET /api/export/history.csv?lotId=1`
- `GET /api/admin/backup`

## Data and backups

The app migrates the original single-location SQLite schema at startup and keeps existing vehicle and history rows in the default **Main Parking** location. Download backups regularly from **Admin** and store them securely. Never publish `parkwise.sqlite`, backup files, passwords, or customer data.

Run `npm test` for the API, migration, authentication, role, reservation, pricing, and reporting checks.
