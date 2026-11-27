CREATE TABLE course_versions (
  version text PRIMARY KEY,
  public_content jsonb NOT NULL CHECK (jsonb_typeof(public_content) = 'object'),
  private_content jsonb NOT NULL CHECK (jsonb_typeof(private_content) = 'object')
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  memory_revision integer NOT NULL DEFAULT 0,
  review_reminders_enabled boolean NOT NULL DEFAULT true,
  memory_suggestions_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE agent_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL CHECK (revision > 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  connection jsonb CHECK (jsonb_typeof(connection) = 'object')
);

CREATE TABLE activities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  seed_key text,
  course_version text NOT NULL REFERENCES course_versions(version),
  claimed_hints text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL CHECK (revision > 0),
  UNIQUE (user_id, seed_key),
  UNIQUE (user_id, id)
);

CREATE INDEX activities_by_user ON activities (user_id);

CREATE TABLE activity_hint_receipts (
  user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  course_version text NOT NULL REFERENCES course_versions(version),
  hint_text text NOT NULL,
  PRIMARY KEY (user_id, command_id),
  UNIQUE (activity_id, expected_revision),
  FOREIGN KEY (user_id, activity_id) REFERENCES activities(user_id, id) ON DELETE CASCADE
);

CREATE TABLE activity_conversation_turns (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  request_id uuid NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  message_text text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('message', 'hint')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'conflict')),
  reply_text text,
  CHECK ((status = 'pending') = (reply_text IS NULL)),
  UNIQUE (activity_id, request_id),
  FOREIGN KEY (user_id, activity_id) REFERENCES activities(user_id, id) ON DELETE CASCADE
);

CREATE INDEX activity_conversation_by_activity ON activity_conversation_turns (activity_id, position);
CREATE UNIQUE INDEX activity_conversation_one_pending ON activity_conversation_turns (activity_id) WHERE status = 'pending';

CREATE TABLE conversations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX conversations_by_recent ON conversations (user_id, updated_at DESC, id);

-- A deleted conversation keeps only its ID, so a late send or review command from another device cannot recreate it.
CREATE TABLE deleted_conversations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE conversation_command_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  command_fingerprint text NOT NULL CHECK (length(command_fingerprint) = 64),
  PRIMARY KEY (user_id, command_id)
);

CREATE TABLE conversation_turns (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  message_text text,
  reply_blocks jsonb CHECK (jsonb_typeof(reply_blocks) = 'array' AND jsonb_array_length(reply_blocks) > 0),
  question_blocks jsonb CHECK (jsonb_typeof(question_blocks) = 'array' AND jsonb_array_length(question_blocks) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'retryable', 'failed', 'stopped', 'complete')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  lease_until timestamptz,
  material_selection jsonb,
  material_context jsonb,
  explanation_source text CHECK (explanation_source IN ('model', 'course', 'excerpt')),
  review_invitation_id uuid,
  kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'review_question')),
  UNIQUE (user_id, request_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations(user_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending') = (lease_until IS NOT NULL)),
  CHECK ((material_selection IS NULL) = (material_context IS NULL)),
  CHECK (
    (kind = 'user' AND message_text IS NOT NULL AND question_blocks IS NULL
      AND ((status = 'complete') = (reply_blocks IS NOT NULL)))
    OR
    (kind = 'review_question' AND message_text IS NULL AND reply_blocks IS NULL
      AND question_blocks IS NOT NULL AND review_invitation_id IS NOT NULL AND status = 'complete'
      AND material_context IS NULL AND explanation_source IS NULL)
  )
);

CREATE UNIQUE INDEX conversation_one_open_turn ON conversation_turns (user_id, conversation_id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX conversation_by_position ON conversation_turns (user_id, conversation_id, position);
CREATE INDEX conversation_discussion_history ON conversation_turns (user_id, (material_context->>'discussionId'), position)
  WHERE material_context IS NOT NULL;

-- A source the user attached, stored once. Turns that read it keep only its ID, name, length and opening.
CREATE TABLE materials (
  user_id uuid NOT NULL,
  source_id text NOT NULL CHECK (source_id LIKE 'excerpt:%'),
  request_id uuid NOT NULL,
  label text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 500000),
  PRIMARY KEY (user_id, source_id),
  FOREIGN KEY (user_id, request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE
);

CREATE TABLE review_invitations (
  user_id uuid NOT NULL,
  id uuid NOT NULL,
  origin_request_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  proposal jsonb NOT NULL,
  question_request_id uuid,
  cancelled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, origin_request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX one_pending_review_invitation ON review_invitations (user_id)
  WHERE question_request_id IS NULL AND NOT cancelled;

CREATE TABLE review_invitation_command_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  review_invitation_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('accept', 'later', 'stop')),
  question_request_id uuid,
  PRIMARY KEY (user_id, command_id)
);

-- One row per answered review question: how well the user recalled it, and why the model judged so.
CREATE TABLE review_attempts (
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  review_invitation_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('recalled', 'partial', 'forgotten')),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 200),
  answered_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, request_id),
  FOREIGN KEY (user_id, request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, review_invitation_id) REFERENCES review_invitations(user_id, id) ON DELETE CASCADE
);

CREATE INDEX review_attempts_by_invitation ON review_attempts (user_id, review_invitation_id);

-- Discussions the user no longer wants reviewed. New proposals from them are not scheduled.
CREATE TABLE review_topic_stops (
  user_id uuid NOT NULL,
  origin_request_id uuid NOT NULL,
  PRIMARY KEY (user_id, origin_request_id),
  FOREIGN KEY (user_id, origin_request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE
);

CREATE TABLE discussion_activities (
  user_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  source_request_id uuid NOT NULL,
  activity_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (user_id, discussion_id),
  FOREIGN KEY (user_id, discussion_id) REFERENCES conversation_turns(user_id, request_id),
  FOREIGN KEY (user_id, source_request_id) REFERENCES conversation_turns(user_id, request_id),
  FOREIGN KEY (user_id, activity_id) REFERENCES activities(user_id, id) ON DELETE CASCADE
);

CREATE TABLE personal_memories (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('statement', 'inference', 'wish')),
  body text,
  topic text NOT NULL DEFAULT '',
  authorized_for_tutoring boolean NOT NULL,
  expires_at timestamptz,
  source_request_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, source_request_id) REFERENCES conversation_turns(user_id, request_id)
);

CREATE TABLE personal_memory_command_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  command_fingerprint text NOT NULL CHECK (length(command_fingerprint) = 64),
  PRIMARY KEY (user_id, command_id)
);

CREATE TABLE personal_memory_extractions (
  user_id uuid NOT NULL,
  source_request_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  memory_revision integer,
  lease_until timestamptz,
  PRIMARY KEY (user_id, source_request_id),
  FOREIGN KEY (user_id, source_request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE
);

CREATE INDEX pending_personal_memory_extractions ON personal_memory_extractions (lease_until)
  WHERE status = 'pending';

-- Decided candidates keep only the fingerprint, so a rebuilt extraction cannot propose them again.
CREATE TABLE personal_memory_candidates (
  user_id uuid NOT NULL,
  id uuid NOT NULL,
  source_request_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed')),
  kind text CHECK (kind IN ('statement', 'inference', 'wish')),
  body text,
  quote text,
  reason text,
  topic text,
  suggested_for_tutoring boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, fingerprint),
  FOREIGN KEY (user_id, source_request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE,
  CHECK ((status = 'pending') = (body IS NOT NULL)),
  CHECK (num_nulls(kind, body, quote, reason, topic, suggested_for_tutoring) IN (0, 6))
);

CREATE TABLE conversation_memory_sources (
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  PRIMARY KEY (user_id, request_id, memory_id),
  FOREIGN KEY (user_id, request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, memory_id) REFERENCES personal_memories(user_id, id) ON DELETE CASCADE
);

CREATE INDEX conversation_memory_by_source ON conversation_memory_sources (user_id, memory_id);

CREATE TABLE conversation_summaries (
  user_id uuid NOT NULL,
  boundary_request_id uuid NOT NULL,
  memory_revision integer NOT NULL,
  source_request_ids uuid[] NOT NULL CHECK (cardinality(source_request_ids) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  attempt integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  summary jsonb,
  PRIMARY KEY (user_id, boundary_request_id, memory_revision),
  FOREIGN KEY (user_id, boundary_request_id) REFERENCES conversation_turns(user_id, request_id) ON DELETE CASCADE,
  CHECK ((status = 'complete') = (summary IS NOT NULL))
);

CREATE INDEX pending_conversation_summaries ON conversation_summaries (lease_until)
  WHERE status = 'pending';
