-- Optional seed. Stock is seeded from content.json by PUT /content; codes only
-- matter for a `pool` gift. The default token gift is `gateway`: no codes needed.
INSERT OR REPLACE INTO stock (gift_id, left) VALUES ('llm-tokens', 10);
