# Ticketly

Event and ticket reservation system. Organizers create events with ticket tiers (VIP, General). Attendees hold tickets for 10 minutes, then pay. The system never double-books a ticket.

GitHub: https://github.com/dharshinir-2606/ticketly
Live URL:https://ticketly-tau.vercel.app/

## Features
- Roles: Admin, Organizer, Attendee
- Events with tiers, quantities and a sales cut-off date
- 10-minute ticket hold, then checkout
- Mock payment gateway (approves or rejects after 2 seconds)
- Organizer dashboard with revenue and sales charts
- Redis caching (optional) and a cron job that releases expired holds

## Tech stack
React (Vite), Node.js + Express, PostgreSQL (Neon), node-cron, JWT

## How double-booking is prevented
Each reservation runs inside a database transaction that locks the ticket-tier row with SELECT ... FOR UPDATE. Requests for the same tier wait their turn, so the last ticket can only be taken once.

## Run locally
    cd backend
    npm install
    npm start

    cd frontend
    npm install
    npm run dev

Set DATABASE_URL and JWT_SECRET in backend/.env, and run backend/schema.sql in your database first.

## Testing
Import postman/Ticketly.postman_collection.json into Postman and run the folders in order.
