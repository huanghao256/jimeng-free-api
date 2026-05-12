import { spawnSync } from "child_process";
import path from "path";
import fs from "fs-extra";

import {
  GENERATION_STATUS,
  MEMBER_ACCOUNT_TYPE,
  OPEN_STATUS,
  TASK_SUBMIT_STATUS,
  GenerationStatusCode,
  MemberAccountTypeCode,
  OpenStatusCode,
  TaskSubmitStatusCode,
  REGION_LABELS,
  toGenerationStatusCode,
  toMemberAccountTypeCode,
  toOpenStatusCode,
  toTaskSubmitStatusCode,
} from "./dictionaries.ts";

const dbDir = path.join(path.resolve(), "data");
const dbPath = path.join(dbDir, "admin.sqlite");

type SqlValue = string | number | boolean | null | undefined;

function now() {
  return new Date().toISOString();
}

function quote(value: SqlValue) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeText(value: any, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeNumber(value: any, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeMaterials(value: TaskRecordInput["materials"]) {
  if (!value) return null;
  if (typeof value === "string") return normalizeText(value) || null;
  const items = value
    .map((item) => ({
      type: normalizeText(item.type, "file"),
      name: normalizeText(item.name),
      path: normalizeText(item.path),
      source: normalizeText(item.source, "path"),
    }))
    .filter((item) => item.path);
  return items.length ? JSON.stringify(items) : null;
}

function parseMaterials(value: any) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ type: "file", name: path.basename(item), path: item, source: "path" }));
  }
}

function execSql(sql: string, json = false) {
  fs.ensureDirSync(dbDir);
  const result = spawnSync("sqlite3", [json ? "-json" : "-batch", dbPath], {
    input: Buffer.from(sql, "utf8"),
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || `sqlite3 exited with status ${result.status}`);
  }

  return result.stdout.toString("utf8").trim();
}

function query(sql: string) {
  const output = execSql(sql, true);
  if (!output) return [];
  return JSON.parse(output);
}

function queryOne(sql: string) {
  return query(sql)[0] || null;
}

function buildSet(data: Record<string, SqlValue>, map: Record<string, string>) {
  const entries = Object.keys(map)
    .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
    .map((key) => `${map[key]} = ${quote(data[key])}`);
  entries.push(`updated_at = ${quote(now())}`);
  return entries.join(", ");
}

function hasTable(name: string) {
  return !!queryOne(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${quote(name)};`);
}

function columnType(tableName: string, columnName: string) {
  const row = query(`PRAGMA table_info(${tableName});`).find((item: any) => item.name === columnName);
  return String(row?.type || "").toUpperCase();
}

function columnDefault(tableName: string, columnName: string) {
  const row = query(`PRAGMA table_info(${tableName});`).find((item: any) => item.name === columnName);
  return String(row?.dflt_value ?? "").replace(/[()']/g, "");
}

function hasColumn(tableName: string, columnName: string) {
  return query(`PRAGMA table_info(${tableName});`).some((item: any) => item.name === columnName);
}

function rebuildTableIfNeeded(tableName: string, checks: Record<string, string>, ddl: string, insertSql: string) {
  if (!hasTable(tableName)) return;
  const needsRebuild = Object.entries(checks).some(([column, expectedType]) => columnType(tableName, column) !== expectedType);
  if (!needsRebuild) return;
  execSql(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    ALTER TABLE ${tableName} RENAME TO ${tableName}_old;
    ${ddl}
    ${insertSql}
    DROP TABLE ${tableName}_old;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export interface TaskRecordInput {
  taskId?: string | null;
  memberId?: number | null;
  accountName: string;
  model: string;
  region: string;
  ratio?: string | null;
  resolution?: string | null;
  duration?: number | null;
  prompt: string;
  materials?: TaskMaterialInput[] | string | null;
  historyId?: string | null;
  submitStatus?: TaskSubmitStatusCode;
  submitFailReason?: string | null;
  generationStatus?: GenerationStatusCode | null;
  generationFailReason?: string | null;
  downloadUrl?: string | null;
  notify?: string | null;
  createdAt?: string;
  generatedAt?: string | null;
}

export interface TaskMaterialInput {
  type?: string | null;
  name?: string | null;
  path: string;
  source?: string | null;
}

const socks5Table = `
  CREATE TABLE IF NOT EXISTS socks5_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    password TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    status INTEGER NOT NULL DEFAULT ${OPEN_STATUS.ENABLED},
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const membersTable = `
  CREATE TABLE IF NOT EXISTS member_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    daily_task_limit INTEGER NOT NULL DEFAULT 0,
    region TEXT NOT NULL DEFAULT '${REGION_LABELS.CN}',
    status INTEGER NOT NULL DEFAULT ${OPEN_STATUS.ENABLED},
    account_type INTEGER NOT NULL DEFAULT ${MEMBER_ACCOUNT_TYPE.FREE},
    credits INTEGER NOT NULL DEFAULT 0,
    close_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const tasksTable = `
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    member_id INTEGER,
    account_name TEXT NOT NULL,
    model TEXT NOT NULL,
    region TEXT NOT NULL,
    ratio TEXT,
    resolution TEXT,
    duration INTEGER,
    prompt TEXT NOT NULL,
    materials TEXT,
    history_id TEXT,
    submit_status INTEGER NOT NULL DEFAULT ${TASK_SUBMIT_STATUS.PENDING},
    submit_fail_reason TEXT,
    generation_status INTEGER NOT NULL DEFAULT ${GENERATION_STATUS.NONE},
    generation_fail_reason TEXT,
    download_url TEXT,
    notify TEXT,
    created_at TEXT NOT NULL,
    generated_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

const systemConfigTable = `
  CREATE TABLE IF NOT EXISTS system_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_type INTEGER NOT NULL DEFAULT ${MEMBER_ACCOUNT_TYPE.FREE},
    region TEXT NOT NULL DEFAULT '${REGION_LABELS.CN}',
    max_parallel_tasks INTEGER NOT NULL DEFAULT 1,
    callback_interval_minutes INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
`;

class AdminDatabase {
  init() {
    execSql(`
      PRAGMA journal_mode = WAL;
      ${socks5Table}
      ${membersTable}
      ${tasksTable}
      ${systemConfigTable}
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_account_name ON tasks(account_name);
      CREATE INDEX IF NOT EXISTS idx_member_session_id ON member_accounts(session_id);
    `);
    this.migrateStatusColumns();
    this.ensureMemberCloseReasonColumn();
    this.ensureTaskIdColumn();
    this.ensureTaskMemberIdColumn();
    this.ensureTaskMaterialsColumn();
    this.ensureTaskNotifyColumn();
    this.backfillTaskIds();
    this.backfillTaskMemberIds();
    this.normalizePendingStatusData();
    this.ensureTaskStatusDefaults();
    this.ensureSystemConfigCallbackIntervalColumn();
    this.ensureSystemConfig();
    this.seedTaskSamples();
    this.backfillSampleMaterials();
  }

  ensureTaskIdColumn() {
    if (!hasColumn("tasks", "task_id")) {
      execSql(`ALTER TABLE tasks ADD COLUMN task_id TEXT;`);
    }
    execSql(`CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);`);
  }

  ensureTaskMemberIdColumn() {
    if (!hasColumn("tasks", "member_id")) {
      execSql(`ALTER TABLE tasks ADD COLUMN member_id INTEGER;`);
    }
    execSql(`CREATE INDEX IF NOT EXISTS idx_tasks_member_id ON tasks(member_id);`);
  }

  ensureTaskMaterialsColumn() {
    if (!hasColumn("tasks", "materials")) {
      execSql(`ALTER TABLE tasks ADD COLUMN materials TEXT;`);
    }
  }

  ensureTaskNotifyColumn() {
    if (!hasColumn("tasks", "notify")) {
      execSql(`ALTER TABLE tasks ADD COLUMN notify TEXT;`);
    }
  }

  ensureMemberCloseReasonColumn() {
    if (!hasColumn("member_accounts", "close_reason")) {
      execSql(`ALTER TABLE member_accounts ADD COLUMN close_reason TEXT;`);
    }
  }

  backfillTaskIds() {
    execSql(`
      UPDATE tasks
      SET task_id = 'task_' || id
      WHERE task_id IS NULL OR task_id = '';
    `);
  }

  backfillTaskMemberIds() {
    execSql(`
      UPDATE tasks
      SET member_id = (
        SELECT id FROM member_accounts
        WHERE member_accounts.account_name = tasks.account_name
        LIMIT 1
      )
      WHERE member_id IS NULL;
    `);
  }

  normalizePendingStatusData() {
    execSql(`
      UPDATE tasks
      SET submit_status = ${TASK_SUBMIT_STATUS.FAILED}
      WHERE submit_status = ${TASK_SUBMIT_STATUS.PENDING}
        AND submit_fail_reason IS NOT NULL
        AND submit_fail_reason <> '';

      UPDATE tasks
      SET generation_status = ${GENERATION_STATUS.NONE}
      WHERE generation_status IS NULL;
    `);
  }

  ensureTaskStatusDefaults() {
    if (columnDefault("tasks", "submit_status") === "0" && columnDefault("tasks", "generation_status") === "0") return;
    execSql(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      ALTER TABLE tasks RENAME TO tasks_old_defaults;
      ${tasksTable.replace("IF NOT EXISTS ", "")}
      INSERT INTO tasks (
        id, task_id, member_id, account_name, model, region, ratio, resolution, duration, prompt, materials, history_id,
        submit_status, submit_fail_reason, generation_status, generation_fail_reason,
        download_url, notify, created_at, generated_at, updated_at
      )
      SELECT
        id, task_id, member_id, account_name, model, region, ratio, resolution, duration, prompt, materials, history_id,
        CASE
          WHEN submit_status = ${TASK_SUBMIT_STATUS.PENDING} AND submit_fail_reason IS NOT NULL AND submit_fail_reason <> '' THEN ${TASK_SUBMIT_STATUS.FAILED}
          WHEN submit_status IS NULL THEN ${TASK_SUBMIT_STATUS.PENDING}
          ELSE submit_status
        END,
        submit_fail_reason,
        COALESCE(generation_status, ${GENERATION_STATUS.NONE}),
        generation_fail_reason,
        download_url, notify, created_at, generated_at, updated_at
      FROM tasks_old_defaults;
      DROP TABLE tasks_old_defaults;
      COMMIT;
      PRAGMA foreign_keys = ON;
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_account_name ON tasks(account_name);
      CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_member_id ON tasks(member_id);
    `);
  }

  backfillSampleMaterials() {
    const timestamp = now();
    const videoMaterials = JSON.stringify([
      { type: "image", name: "first-frame.png", path: "D:\\jimeng\\materials\\first-frame.png", source: "path" },
      { type: "image", name: "last-frame.png", path: "D:\\jimeng\\materials\\last-frame.png", source: "path" },
    ]);
    const imageMaterials = JSON.stringify([
      { type: "image", name: "reference.png", path: "D:\\jimeng\\materials\\reference.png", source: "path" },
    ]);
    execSql(`
      UPDATE tasks
      SET materials = ${quote(videoMaterials)}, updated_at = ${quote(timestamp)}
      WHERE task_id = 'demo_sync_10002' AND (materials IS NULL OR materials = '');

      UPDATE tasks
      SET materials = ${quote(imageMaterials)}, updated_at = ${quote(timestamp)}
      WHERE task_id = 'demo_sync_10003' AND (materials IS NULL OR materials = '');
    `);
  }

  ensureSystemConfig() {
    const timestamp = now();
    execSql(`
      INSERT OR IGNORE INTO system_config (id, account_type, region, max_parallel_tasks, callback_interval_minutes, updated_at)
      VALUES (1, ${MEMBER_ACCOUNT_TYPE.FREE}, ${quote(REGION_LABELS.CN)}, 1, 1, ${quote(timestamp)});
    `);
  }

  ensureSystemConfigCallbackIntervalColumn() {
    if (!hasColumn("system_config", "callback_interval_minutes")) {
      execSql(`ALTER TABLE system_config ADD COLUMN callback_interval_minutes INTEGER NOT NULL DEFAULT 1;`);
    }
  }

  migrateStatusColumns() {
    rebuildTableIfNeeded(
      "socks5_accounts",
      { status: "INTEGER" },
      socks5Table.replace("IF NOT EXISTS ", ""),
      `
        INSERT INTO socks5_accounts (id, account, password, host, port, status, created_at, updated_at)
        SELECT id, account, password, host, port,
          CASE WHEN status IN ('0', '关闭', '鍏抽棴') THEN ${OPEN_STATUS.DISABLED} ELSE ${OPEN_STATUS.ENABLED} END,
          created_at, updated_at
        FROM socks5_accounts_old;
      `
    );

    rebuildTableIfNeeded(
      "member_accounts",
      { status: "INTEGER", account_type: "INTEGER" },
      membersTable.replace("IF NOT EXISTS ", ""),
      `
        INSERT INTO member_accounts (
          id, account_name, session_id, daily_task_limit, region, status, account_type, credits, created_at, updated_at
        )
        SELECT id, account_name, session_id, daily_task_limit, region,
          CASE WHEN status IN ('0', '关闭', '鍏抽棴') THEN ${OPEN_STATUS.DISABLED} ELSE ${OPEN_STATUS.ENABLED} END,
          CASE WHEN account_type IN ('1', '收费', '鏀惰垂') THEN ${MEMBER_ACCOUNT_TYPE.PAID} ELSE ${MEMBER_ACCOUNT_TYPE.FREE} END,
          credits, created_at, updated_at
        FROM member_accounts_old;
      `
    );

    rebuildTableIfNeeded(
      "tasks",
      { submit_status: "INTEGER", generation_status: "INTEGER" },
      tasksTable.replace("IF NOT EXISTS ", ""),
      `
        INSERT INTO tasks (
          id, task_id, member_id, account_name, model, region, ratio, resolution, duration, prompt, materials, history_id,
          submit_status, submit_fail_reason, generation_status, generation_fail_reason,
          download_url, notify, created_at, generated_at, updated_at
        )
        SELECT id, NULL, NULL, account_name, model, region, ratio, resolution, duration, prompt, NULL, history_id,
          CASE WHEN submit_status IN ('0', '失败', '澶辫触') THEN ${TASK_SUBMIT_STATUS.FAILED} ELSE ${TASK_SUBMIT_STATUS.SUCCESS} END,
          submit_fail_reason,
          CASE
            WHEN generation_status IS NULL OR generation_status = '' THEN ${GENERATION_STATUS.NONE}
            WHEN generation_status IN ('1', '生成中', '鐢熸垚涓?') THEN ${GENERATION_STATUS.PROCESSING}
            WHEN generation_status IN ('2', '已生成', '宸茬敓鎴?') THEN ${GENERATION_STATUS.GENERATED}
            ELSE ${GENERATION_STATUS.FAILED}
          END,
          generation_fail_reason, download_url, NULL, created_at, generated_at, updated_at
        FROM tasks_old;
      `
    );
  }

  listSocks5Accounts() {
    return query(`
      SELECT id, account, password, host, port, status, created_at AS createdAt, updated_at AS updatedAt
      FROM socks5_accounts
      ORDER BY id DESC;
    `);
  }

  createSocks5Account(payload: any) {
    const timestamp = now();
    const row = queryOne(`
      INSERT INTO socks5_accounts (account, password, host, port, status, created_at, updated_at)
      VALUES (
        ${quote(normalizeText(payload.account))},
        ${quote(normalizeText(payload.password))},
        ${quote(normalizeText(payload.host))},
        ${quote(normalizeNumber(payload.port))},
        ${quote(toOpenStatusCode(payload.status))},
        ${quote(timestamp)},
        ${quote(timestamp)}
      )
      RETURNING id;
    `);
    return row?.id;
  }

  createSocks5Accounts(items: any[]) {
    const ids: number[] = [];
    for (const item of items) {
      ids.push(Number(this.createSocks5Account(item)));
    }
    return ids.filter(Boolean);
  }

  updateSocks5Account(id: number, payload: any) {
    const normalized = { ...payload };
    if (Object.prototype.hasOwnProperty.call(normalized, "status")) normalized.status = toOpenStatusCode(normalized.status);
    const setSql = buildSet(normalized, {
      account: "account",
      password: "password",
      host: "host",
      port: "port",
      status: "status",
    });
    execSql(`UPDATE socks5_accounts SET ${setSql} WHERE id = ${quote(id)};`);
  }

  deleteSocks5Account(id: number) {
    execSql(`DELETE FROM socks5_accounts WHERE id = ${quote(id)};`);
  }

  deleteSocks5Accounts(ids: number[]) {
    const validIds = ids.filter((id) => Number.isInteger(id) && id > 0);
    if (!validIds.length) return 0;
    execSql(`DELETE FROM socks5_accounts WHERE id IN (${validIds.map(quote).join(", ")});`);
    return validIds.length;
  }

  updateSocks5AccountsStatus(ids: number[], status: OpenStatusCode) {
    const validIds = ids.filter((id) => Number.isInteger(id) && id > 0);
    if (!validIds.length) return 0;
    execSql(`
      UPDATE socks5_accounts
      SET status = ${quote(toOpenStatusCode(status))},
          updated_at = ${quote(now())}
      WHERE id IN (${validIds.map(quote).join(", ")});
    `);
    return validIds.length;
  }

  listMemberAccounts() {
    return query(`
      SELECT
        m.id,
        m.account_name AS accountName,
        m.session_id AS sessionId,
        COALESCE(t.today_task_count, 0) AS todayTaskCount,
        m.daily_task_limit AS dailyTaskLimit,
        m.region,
        m.status,
        m.account_type AS accountType,
        m.credits,
        m.close_reason AS closeReason,
        m.created_at AS createdAt,
        m.updated_at AS updatedAt
      FROM member_accounts m
      LEFT JOIN (
        SELECT member_id, COUNT(*) AS today_task_count
        FROM tasks
        WHERE member_id IS NOT NULL
          AND date(created_at, 'localtime') = date('now', 'localtime')
        GROUP BY member_id
      ) t ON t.member_id = m.id
      ORDER BY m.id DESC;
    `);
  }

  createMemberAccount(payload: any) {
    const timestamp = now();
    const row = queryOne(`
      INSERT INTO member_accounts (
        account_name, session_id, daily_task_limit, region, status, account_type, credits, close_reason, created_at, updated_at
      )
      VALUES (
        ${quote(normalizeText(payload.accountName))},
        ${quote(normalizeText(payload.sessionId))},
        ${quote(normalizeNumber(payload.dailyTaskLimit))},
        ${quote(normalizeText(payload.region, REGION_LABELS.CN))},
        ${quote(toOpenStatusCode(payload.status))},
        ${quote(toMemberAccountTypeCode(payload.accountType))},
        ${quote(normalizeNumber(payload.credits))},
        ${quote(normalizeText(payload.closeReason) || null)},
        ${quote(timestamp)},
        ${quote(timestamp)}
      )
      RETURNING id;
    `);
    return row?.id;
  }

  updateMemberAccount(id: number, payload: any) {
    const normalized = { ...payload };
    if (Object.prototype.hasOwnProperty.call(normalized, "status")) normalized.status = toOpenStatusCode(normalized.status);
    if (Object.prototype.hasOwnProperty.call(normalized, "accountType")) normalized.accountType = toMemberAccountTypeCode(normalized.accountType);
    const setSql = buildSet(normalized, {
      accountName: "account_name",
      sessionId: "session_id",
      dailyTaskLimit: "daily_task_limit",
      region: "region",
      status: "status",
      accountType: "account_type",
      credits: "credits",
      closeReason: "close_reason",
    });
    execSql(`UPDATE member_accounts SET ${setSql} WHERE id = ${quote(id)};`);
    if (normalized.status === OPEN_STATUS.ENABLED && !Object.prototype.hasOwnProperty.call(normalized, "closeReason")) {
      execSql(`UPDATE member_accounts SET close_reason = NULL WHERE id = ${quote(id)};`);
    }
  }

  deleteMemberAccount(id: number) {
    execSql(`DELETE FROM member_accounts WHERE id = ${quote(id)};`);
  }

  deleteMemberAccounts(ids: number[]) {
    const validIds = ids.filter((id) => Number.isInteger(id) && id > 0);
    if (!validIds.length) return 0;
    execSql(`DELETE FROM member_accounts WHERE id IN (${validIds.map(quote).join(", ")});`);
    return validIds.length;
  }

  updateMemberAccountsStatus(ids: number[], status: OpenStatusCode) {
    const validIds = ids.filter((id) => Number.isInteger(id) && id > 0);
    if (!validIds.length) return 0;
    const nextStatus = toOpenStatusCode(status);
    execSql(`
      UPDATE member_accounts
      SET status = ${quote(nextStatus)},
          close_reason = ${nextStatus === OPEN_STATUS.ENABLED ? "NULL" : "close_reason"},
          updated_at = ${quote(now())}
      WHERE id IN (${validIds.map(quote).join(", ")});
    `);
    return validIds.length;
  }

  closeMemberAccount(id: number, reason: string) {
    execSql(`
      UPDATE member_accounts
      SET status = ${OPEN_STATUS.DISABLED},
          close_reason = ${quote(normalizeText(reason, "Task submit failed"))},
          updated_at = ${quote(now())}
      WHERE id = ${quote(id)};
    `);
  }

  importMemberAccounts(rows: any[]) {
    const ids: number[] = [];
    for (const row of rows) {
      const accountName = normalizeText(row.accountName || row["账号名称"]);
      const sessionId = normalizeText(row.sessionId || row.sessionID || row["sessionId"] || row["sessionID"]);
      if (!accountName || !sessionId) continue;
      ids.push(Number(this.createMemberAccount({
        accountName,
        sessionId,
        accountType: toMemberAccountTypeCode(row.accountType || row["是否收费"]),
        dailyTaskLimit: row.dailyTaskLimit || 0,
        region: row.region || REGION_LABELS.CN,
        status: OPEN_STATUS.ENABLED,
        credits: row.credits || 0,
      })));
    }
    return ids.filter(Boolean);
  }

  findMemberBySessionId(sessionId: string) {
    const token = normalizeText(sessionId);
    if (!token) return null;
    return queryOne(`
      SELECT
        id,
        account_name AS accountName,
        session_id AS sessionId,
        region,
        status,
        account_type AS accountType,
        credits,
        close_reason AS closeReason
      FROM member_accounts
      WHERE session_id = ${quote(token)}
      LIMIT 1;
    `);
  }

  findMemberById(id: number) {
    return queryOne(`
      SELECT
        id,
        account_name AS accountName,
        session_id AS sessionId,
        daily_task_limit AS dailyTaskLimit,
        region,
        status,
        account_type AS accountType,
        credits,
        close_reason AS closeReason
      FROM member_accounts
      WHERE id = ${quote(id)}
      LIMIT 1;
    `);
  }

  listRunnableMemberAccounts(region: string, accountType: number) {
    return query(`
      SELECT
        id,
        account_name AS accountName,
        session_id AS sessionId,
        daily_task_limit AS dailyTaskLimit,
        region,
        status,
        account_type AS accountType,
        credits,
        close_reason AS closeReason
      FROM member_accounts
      WHERE status = ${OPEN_STATUS.ENABLED}
        AND region = ${quote(normalizeText(region, REGION_LABELS.CN))}
        AND account_type = ${quote(toMemberAccountTypeCode(accountType))}
      ORDER BY id ASC;
    `);
  }

  listTasks() {
    return query(`
      SELECT
        id,
        task_id AS taskId,
        member_id AS memberId,
        account_name AS accountName,
        model,
        region,
        ratio,
        resolution,
        duration,
        prompt,
        materials,
        history_id AS historyId,
        submit_status AS submitStatus,
        submit_fail_reason AS submitFailReason,
        generation_status AS generationStatus,
        generation_fail_reason AS generationFailReason,
        download_url AS downloadUrl,
        notify,
        created_at AS createdAt,
        generated_at AS generatedAt,
        updated_at AS updatedAt
      FROM tasks
      ORDER BY datetime(created_at) DESC, id DESC;
    `).map((row: any) => ({ ...row, materials: parseMaterials(row.materials) }));
  }

  listPendingTasks(limit: number) {
    const safeLimit = Math.max(1, Math.floor(normalizeNumber(limit, 1)));
    return query(`
      SELECT
        id,
        task_id AS taskId,
        member_id AS memberId,
        account_name AS accountName,
        model,
        region,
        ratio,
        resolution,
        duration,
        prompt,
        materials,
        history_id AS historyId,
        submit_status AS submitStatus,
        submit_fail_reason AS submitFailReason,
        generation_status AS generationStatus,
        generation_fail_reason AS generationFailReason,
        download_url AS downloadUrl,
        notify,
        created_at AS createdAt,
        generated_at AS generatedAt,
        updated_at AS updatedAt
      FROM tasks
      WHERE submit_status = ${TASK_SUBMIT_STATUS.PENDING}
      ORDER BY datetime(created_at) ASC, id ASC
      LIMIT ${safeLimit};
    `).map((row: any) => ({ ...row, materials: parseMaterials(row.materials) }));
  }

  listSubmittedProcessingTasks() {
    return query(`
      SELECT
        id,
        task_id AS taskId,
        member_id AS memberId,
        account_name AS accountName,
        model,
        region,
        ratio,
        resolution,
        duration,
        prompt,
        materials,
        history_id AS historyId,
        submit_status AS submitStatus,
        submit_fail_reason AS submitFailReason,
        generation_status AS generationStatus,
        generation_fail_reason AS generationFailReason,
        download_url AS downloadUrl,
        notify,
        created_at AS createdAt,
        generated_at AS generatedAt,
        updated_at AS updatedAt
      FROM tasks
      WHERE submit_status = ${TASK_SUBMIT_STATUS.SUCCESS}
        AND generation_status = ${GENERATION_STATUS.PROCESSING}
        AND history_id IS NOT NULL
        AND history_id <> ''
      ORDER BY datetime(created_at) ASC, id ASC;
    `).map((row: any) => ({ ...row, materials: parseMaterials(row.materials) }));
  }

  countProcessingGenerationTasks() {
    return Number(queryOne(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE generation_status = ${GENERATION_STATUS.PROCESSING};
    `)?.count || 0);
  }

  createTask(input: TaskRecordInput) {
    const timestamp = now();
    const row = queryOne(`
      INSERT INTO tasks (
        task_id, member_id, account_name, model, region, ratio, resolution, duration, prompt, materials, history_id,
        submit_status, submit_fail_reason, generation_status, generation_fail_reason,
        download_url, notify, created_at, generated_at, updated_at
      )
      VALUES (
        ${quote(input.taskId || this.generateTaskId())},
        ${quote(input.memberId ?? null)},
        ${quote(input.accountName)},
        ${quote(input.model)},
        ${quote(input.region)},
        ${quote(input.ratio || null)},
        ${quote(input.resolution || null)},
        ${quote(input.duration ?? null)},
        ${quote(input.prompt)},
        ${quote(normalizeMaterials(input.materials))},
        ${quote(input.historyId || null)},
        ${quote(toTaskSubmitStatusCode(input.submitStatus))},
        ${quote(input.submitFailReason || null)},
        ${quote(toGenerationStatusCode(input.generationStatus))},
        ${quote(input.generationFailReason || null)},
        ${quote(input.downloadUrl || null)},
        ${quote(normalizeText(input.notify) || null)},
        ${quote(input.createdAt || timestamp)},
        ${quote(input.generatedAt || null)},
        ${quote(timestamp)}
      )
      RETURNING id;
    `);
    return Number(row?.id);
  }

  markTaskSubmitted(id: number, historyId: string, member?: { id?: number; accountName?: string }) {
    execSql(`
      UPDATE tasks
      SET history_id = ${quote(historyId)},
          ${member?.id ? `member_id = ${quote(member.id)},` : ""}
          ${member?.accountName ? `account_name = ${quote(member.accountName)},` : ""}
          submit_status = ${TASK_SUBMIT_STATUS.SUCCESS},
          generation_status = ${GENERATION_STATUS.PROCESSING},
          updated_at = ${quote(now())}
      WHERE id = ${quote(id)};
    `);
  }

  markTaskSubmitFailed(id: number, reason: string) {
    execSql(`
      UPDATE tasks
      SET submit_status = ${TASK_SUBMIT_STATUS.FAILED},
          submit_fail_reason = ${quote(reason)},
          generation_status = ${GENERATION_STATUS.NONE},
          updated_at = ${quote(now())}
      WHERE id = ${quote(id)};
    `);
  }

  markTaskGenerated(id: number, downloadUrl: string) {
    const timestamp = now();
    execSql(`
      UPDATE tasks
      SET generation_status = ${GENERATION_STATUS.GENERATED},
          generation_fail_reason = NULL,
          download_url = ${quote(downloadUrl)},
          generated_at = ${quote(timestamp)},
          updated_at = ${quote(timestamp)}
      WHERE id = ${quote(id)};
    `);
  }

  markTaskGenerationFailed(id: number, reason: string) {
    const timestamp = now();
    execSql(`
      UPDATE tasks
      SET generation_status = ${GENERATION_STATUS.FAILED},
          generation_fail_reason = ${quote(reason)},
          generated_at = ${quote(timestamp)},
          updated_at = ${quote(timestamp)}
      WHERE id = ${quote(id)};
    `);
  }

  deleteTask(id: number) {
    execSql(`DELETE FROM tasks WHERE id = ${quote(id)};`);
  }

  getSystemConfig() {
    this.ensureSystemConfigCallbackIntervalColumn();
    this.ensureSystemConfig();
    return queryOne(`
      SELECT
        account_type AS accountType,
        region,
        max_parallel_tasks AS maxParallelTasks,
        callback_interval_minutes AS callbackIntervalMinutes,
        updated_at AS updatedAt
      FROM system_config
      WHERE id = 1;
    `);
  }

  updateSystemConfig(payload: any) {
    const maxParallelTasks = Math.max(1, Math.floor(normalizeNumber(payload.maxParallelTasks, 1)));
    const callbackIntervalMinutes = Math.max(1, Math.floor(normalizeNumber(payload.callbackIntervalMinutes, 1)));
    const timestamp = now();
    execSql(`
      UPDATE system_config
      SET account_type = ${quote(toMemberAccountTypeCode(payload.accountType))},
          region = ${quote(normalizeText(payload.region, REGION_LABELS.CN))},
          max_parallel_tasks = ${quote(maxParallelTasks)},
          callback_interval_minutes = ${quote(callbackIntervalMinutes)},
          updated_at = ${quote(timestamp)}
      WHERE id = 1;
    `);
    return this.getSystemConfig();
  }

  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  seedTaskSamples() {
    const total = queryOne(`SELECT COUNT(*) AS count FROM tasks;`)?.count || 0;
    if (Number(total) > 0) return;

    const timestamp = now();
    const samples: TaskRecordInput[] = [
      {
        taskId: "demo_sync_10001",
        accountName: "演示账号A",
        model: "jimeng-4.5",
        region: REGION_LABELS.CN,
        ratio: "1:1",
        resolution: "2k",
        duration: null,
        prompt: "一只透明玻璃质感的未来城市建筑，日落光线，超清细节",
        historyId: "734928102938475",
        submitStatus: TASK_SUBMIT_STATUS.SUCCESS,
        generationStatus: GENERATION_STATUS.GENERATED,
        downloadUrl: "https://example.com/demo-image-1.png",
        createdAt: timestamp,
        generatedAt: timestamp,
      },
      {
        taskId: "demo_sync_10002",
        accountName: "演示账号B",
        model: "jimeng-video-seedance-2.0",
        region: REGION_LABELS.US,
        ratio: "16:9",
        resolution: "1080p",
        duration: 8,
        prompt: "赛博朋克街道雨夜镜头，霓虹倒影，缓慢推进",
        historyId: "734928102938476",
        submitStatus: TASK_SUBMIT_STATUS.SUCCESS,
        generationStatus: GENERATION_STATUS.PROCESSING,
        createdAt: timestamp,
      },
      {
        taskId: "demo_sync_10003",
        accountName: "演示账号C",
        model: "jimeng-3.1",
        region: REGION_LABELS.JP,
        ratio: "3:4",
        resolution: "1k",
        duration: null,
        prompt: "动漫风格的樱花庭院，柔和晨光，人物背影",
        historyId: "734928102938477",
        submitStatus: TASK_SUBMIT_STATUS.SUCCESS,
        generationStatus: GENERATION_STATUS.FAILED,
        generationFailReason: "内容审核未通过",
        createdAt: timestamp,
        generatedAt: timestamp,
      },
      {
        taskId: "demo_sync_10004",
        accountName: "演示账号D",
        model: "jimeng-4.0",
        region: REGION_LABELS.HK,
        ratio: "9:16",
        resolution: "2k",
        duration: null,
        prompt: "竖屏商业海报，蓝白科技风，产品悬浮展示",
        historyId: null,
        submitStatus: TASK_SUBMIT_STATUS.FAILED,
        submitFailReason: "账号积分不足",
        generationStatus: null,
        createdAt: timestamp,
      },
    ];

    samples.forEach((sample) => this.createTask(sample));
  }
}

export default new AdminDatabase();
