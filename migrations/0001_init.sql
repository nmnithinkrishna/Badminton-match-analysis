-- One row per analysis job. The raw video is never stored by us.
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,              -- CREATED | UPLOADED | PROCESSING_VIDEO | ANALYSING | WAITING_QUOTA | READY | FAILED
  player_description TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  duration_s REAL,
  gemini_file TEXT,                 -- files/xxx, cleared after deletion
  upload_url TEXT,                  -- resumable session URL, cleared after upload
  report_json TEXT,
  error TEXT,
  model TEXT,
  prompt_version TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX analyses_created_at ON analyses (created_at);
CREATE INDEX analyses_state ON analyses (state);
