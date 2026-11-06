-- How full the model's context may get, and how many tools one answer may
-- call, set by system administrators: .agents/design/configuration.md 10.9.

ALTER TABLE system_settings
    ADD COLUMN assistant_compress_percent integer,
    ADD COLUMN assistant_max_tool_calls integer,
    ADD CONSTRAINT system_settings_assistant_compress_percent_check CHECK (assistant_compress_percent BETWEEN 1 AND 100),
    ADD CONSTRAINT system_settings_assistant_max_tool_calls_check CHECK (assistant_max_tool_calls >= 0);

COMMENT ON COLUMN system_settings.assistant_compress_percent IS 'Share of a model''s usable context, in percent, past which the AI assistant summarizes the earlier part of a conversation before answering, and an answer stops calling tools; NULL follows the default.';
COMMENT ON COLUMN system_settings.assistant_max_tool_calls IS 'The most tools one answer of the AI assistant may call; 0 sets no limit, NULL follows the default.';
