-- Demo: a generic guestbook / comment board. Safe to apply more than once.
-- Note: no moderation columns here. Moderation state lives in schema shadowmod.

CREATE TABLE IF NOT EXISTS guestbook_post (
  id         bigserial PRIMARY KEY,
  author     text NOT NULL,
  body       text NOT NULL,
  context    text,                 -- e.g. thread title; context reduces false positives
  created_at timestamptz NOT NULL DEFAULT now()
);

SELECT shadowmod.target_id('guestbook_post', 'body');
