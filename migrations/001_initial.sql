CREATE TABLE curriculum_versions (
  version text PRIMARY KEY,
  public_content jsonb NOT NULL CHECK (jsonb_typeof(public_content) = 'object'),
  private_content jsonb NOT NULL CHECK (jsonb_typeof(private_content) = 'object')
);

CREATE TABLE learners (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  memory_revision integer NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE agent_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL CHECK (revision > 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE activities (
  id uuid PRIMARY KEY,
  learner_id uuid NOT NULL REFERENCES learners(id),
  title text NOT NULL,
  seed_key text,
  course_version text NOT NULL REFERENCES curriculum_versions(version),
  published_hints text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL CHECK (revision > 0),
  UNIQUE (learner_id, seed_key),
  UNIQUE (learner_id, id)
);

CREATE INDEX activities_by_learner ON activities (learner_id);

CREATE TABLE activity_hint_receipts (
  learner_id uuid NOT NULL,
  command_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision > 0),
  activity_version text NOT NULL REFERENCES curriculum_versions(version),
  hint_text text NOT NULL,
  PRIMARY KEY (learner_id, command_id),
  UNIQUE (activity_id, request_revision),
  FOREIGN KEY (learner_id, activity_id) REFERENCES activities(learner_id, id) ON DELETE CASCADE
);

CREATE TABLE activity_chat_turns (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  learner_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision > 0),
  message_text text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('message', 'hint')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'conflict')),
  reply_text text,
  CHECK ((status = 'pending') = (reply_text IS NULL)),
  UNIQUE (activity_id, request_id),
  FOREIGN KEY (learner_id, activity_id) REFERENCES activities(learner_id, id) ON DELETE CASCADE
);

CREATE INDEX activity_chat_by_activity ON activity_chat_turns (activity_id, position);
CREATE UNIQUE INDEX activity_chat_one_pending ON activity_chat_turns (activity_id) WHERE status = 'pending';

CREATE TABLE chat_turns (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  message_text text NOT NULL,
  content_blocks jsonb CHECK (jsonb_typeof(content_blocks) = 'array' AND jsonb_array_length(content_blocks) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'retryable', 'failed', 'stopped', 'complete')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  lease_until timestamptz,
  material_command jsonb,
  material_context jsonb,
  explanation_mode text CHECK (explanation_mode IN ('model', 'course', 'excerpt')),
  UNIQUE (learner_id, request_id),
  CHECK ((status = 'complete') = (content_blocks IS NOT NULL)),
  CHECK ((status = 'pending') = (lease_until IS NOT NULL)),
  CHECK ((material_command IS NULL) = (material_context IS NULL))
);

CREATE UNIQUE INDEX chat_one_open_turn ON chat_turns (learner_id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX chat_by_learner_position ON chat_turns (learner_id, position);
CREATE INDEX chat_discussion_history ON chat_turns (learner_id, (material_context->>'discussionId'), position)
  WHERE material_context IS NOT NULL;

CREATE TABLE discussion_practices (
  learner_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  source_request_id uuid NOT NULL,
  activity_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (learner_id, discussion_id),
  FOREIGN KEY (learner_id, discussion_id) REFERENCES chat_turns(learner_id, request_id),
  FOREIGN KEY (learner_id, source_request_id) REFERENCES chat_turns(learner_id, request_id),
  FOREIGN KEY (learner_id, activity_id) REFERENCES activities(learner_id, id) ON DELETE CASCADE
);

CREATE TABLE personal_memories (
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('statement', 'inference', 'wish')),
  body text,
  topic text NOT NULL DEFAULT '',
  authorized boolean NOT NULL,
  expires_at timestamptz,
  source_request_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (learner_id, id),
  FOREIGN KEY (learner_id, source_request_id) REFERENCES chat_turns(learner_id, request_id)
);

CREATE TABLE memory_command_receipts (
  learner_id uuid NOT NULL,
  command_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('remember', 'correct', 'forget')),
  result_revision integer NOT NULL,
  PRIMARY KEY (learner_id, command_id),
  FOREIGN KEY (learner_id, memory_id) REFERENCES personal_memories(learner_id, id) ON DELETE CASCADE
);

CREATE TABLE chat_memory_sources (
  learner_id uuid NOT NULL,
  request_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  PRIMARY KEY (learner_id, request_id, memory_id),
  FOREIGN KEY (learner_id, request_id) REFERENCES chat_turns(learner_id, request_id) ON DELETE CASCADE,
  FOREIGN KEY (learner_id, memory_id) REFERENCES personal_memories(learner_id, id) ON DELETE CASCADE
);

CREATE INDEX chat_memory_by_source ON chat_memory_sources (learner_id, memory_id);

CREATE TABLE conversation_summaries (
  learner_id uuid NOT NULL,
  boundary_request_id uuid NOT NULL,
  memory_revision integer NOT NULL,
  source_request_ids uuid[] NOT NULL CHECK (cardinality(source_request_ids) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  attempt integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  summary jsonb,
  PRIMARY KEY (learner_id, boundary_request_id, memory_revision),
  FOREIGN KEY (learner_id, boundary_request_id) REFERENCES chat_turns(learner_id, request_id) ON DELETE CASCADE,
  CHECK ((status = 'complete') = (summary IS NOT NULL))
);

CREATE INDEX pending_conversation_summaries ON conversation_summaries (lease_until)
  WHERE status = 'pending';
