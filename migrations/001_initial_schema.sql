CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
  last_name VARCHAR(100) NOT NULL CHECK (length(trim(last_name)) > 0),
  email VARCHAR(320) NOT NULL CHECK (length(trim(email)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'open' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE TABLE task_assignments (
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE idempotency_requests (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  route VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key, method, route)
);

CREATE TABLE notification_jobs (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  attempt_number SMALLINT NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  error_message TEXT,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(32) NOT NULL CHECK (
    event_type IN ('task_created', 'users_assigned', 'user_completed', 'task_archived')
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_task_assignments_user_pending
  ON task_assignments(user_id)
  WHERE completed_at IS NULL;
CREATE INDEX idx_notification_jobs_due
  ON notification_jobs(next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX idx_notification_attempts_job
  ON notification_attempts(job_id, attempt_number);
CREATE INDEX idx_task_events_task
  ON task_events(task_id, created_at, id);
