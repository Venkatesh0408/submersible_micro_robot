-- ==========================================================
-- VSTY SUBMERSIBLE MICRO ROBOT — ROBOT & CAMERA CONFIGURATIONS
-- Migration: 20261030_robot_configurations.sql
-- ==========================================================

CREATE TABLE IF NOT EXISTS robot_configurations (
    user_id TEXT PRIMARY KEY,
    robot_name TEXT NOT NULL DEFAULT 'VSTY Submersible Micro Robot',
    camera_ip TEXT NOT NULL DEFAULT '',
    stream_port INTEGER NOT NULL DEFAULT 81,
    capture_port INTEGER NOT NULL DEFAULT 80,
    stream_path TEXT NOT NULL DEFAULT '/stream',
    capture_path TEXT NOT NULL DEFAULT '/capture',
    connection_mode TEXT NOT NULL DEFAULT 'LOCAL_GATEWAY',
    last_verified_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick lookup by user
CREATE INDEX IF NOT EXISTS idx_robot_configurations_user_id ON robot_configurations(user_id);

COMMENT ON TABLE robot_configurations IS 'Persistent user-isolated camera & robot hardware configurations for VSTY Mission Control';
