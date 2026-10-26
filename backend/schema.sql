CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'attendee' CHECK (role IN ('admin','organizer','attendee')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  organizer_id INT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  venue TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  sales_end_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ticket_tiers (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  total_qty INT NOT NULL CHECK (total_qty > 0),
  available_qty INT NOT NULL CHECK (available_qty >= 0)
);
CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  tier_id INT NOT NULL REFERENCES ticket_tiers(id),
  qty INT NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','checkout','paid','expired','cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_res_expiry ON reservations(status, expires_at);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  reservation_id INT UNIQUE NOT NULL REFERENCES reservations(id),
  user_id INT NOT NULL REFERENCES users(id),
  total_cents INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id),
  amount_cents INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved','rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);
