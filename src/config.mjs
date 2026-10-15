import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { parseEnv } from 'node:util';

export function assert(ok, message) { if (!ok) throw new Error(message); }
export function within(parent, child) {
  const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
export function loadConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  assert(c.schemaVersion === 1, 'Unsupported config schema');
  assert(typeof c.pageId==='string' && typeof c.appId==='string' && /^\d+$/.test(c.pageId) && /^\d+$/.test(c.appId), 'Set pageId and appId as numeric strings');
  assert(/^[a-z][a-z0-9-]{0,47}$/.test(c.agentId) && c.agentId !== 'main', 'Use a dedicated agentId, not main');
  assert(typeof c.model === 'string' && c.model.trim().length > 0 && !c.model.includes('REPLACE'), 'Set a model the Hermes runtime can call (bare id like deepseek-v4.1-flash, or provider/model)');
  assert(/^v\d+\.\d+$/.test(c.graphVersion), 'Invalid graphVersion');
  assert(['draft','live'].includes(c.mode), 'mode must be draft or live');
  c.waitingResetSeconds ??= 0;
  c.messageDebounceSeconds ??= 2;
  // Khi nhân viên trả lời trực tiếp trên Page, bot im lặng (trạng thái HUMAN). Nếu
  // nhân viên không nhắn gì thêm trong khoảng này thì bot tiếp tục trả lời khách.
  c.humanIdleResetSeconds ??= 300;
  // Conversation session TTL: a customer message that arrives more than this
  // many seconds after the previous one starts a NEW session (topic is reset,
  // the finished session is queued for summarisation). 0 keeps one session
  // forever, which is the old behaviour.
  c.sessionTtlSeconds ??= 21600;
  c.enableHumanHandoff ??= true;
  c.marketing ??= {};
  c.marketing.enabled ??= false;
  c.marketing.approvalRequired ??= true;
  c.marketing.maxPostsPerDay ??= 3;
  c.marketing.defaultTone ??= 'thân thiện, chuyên nghiệp, ngắn gọn';
  c.marketing.timezone ??= 'Asia/Ho_Chi_Minh';
  c.marketing.quietHours ??= '22:00-07:00';
  c.marketing.minScore ??= 0;
  c.marketing.reviseAttempts ??= 1;
  c.marketing.lowScoreAction ??= 'warn';
  c.marketing.minImagesPerPost ??= 3;
  assert(typeof c.marketing.enabled === 'boolean', 'Invalid marketing.enabled');
  assert(c.marketing.approvalRequired === true, 'marketing approval is required');
  assert(Number.isInteger(c.marketing.maxPostsPerDay) && c.marketing.maxPostsPerDay > 0 && c.marketing.maxPostsPerDay <= 50, 'Invalid marketing.maxPostsPerDay');
  assert(typeof c.marketing.defaultTone === 'string' && c.marketing.defaultTone.trim().length > 0 && c.marketing.defaultTone.length <= 500, 'Invalid marketing.defaultTone');
  assert(typeof c.marketing.timezone === 'string' && c.marketing.timezone.trim().length > 0 && c.marketing.timezone.length <= 100, 'Invalid marketing.timezone');
  assert(/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(c.marketing.quietHours), 'Invalid marketing.quietHours');
  assert(Number.isInteger(c.marketing.minScore) && c.marketing.minScore >= 0 && c.marketing.minScore <= 10, 'Invalid marketing.minScore (0-10, 0 = no gate)');
  assert(Number.isInteger(c.marketing.reviseAttempts) && c.marketing.reviseAttempts >= 0 && c.marketing.reviseAttempts <= 3, 'Invalid marketing.reviseAttempts (0-3)');
  assert(['warn','hold'].includes(c.marketing.lowScoreAction), 'Invalid marketing.lowScoreAction (warn|hold)');
  assert(Number.isInteger(c.marketing.minImagesPerPost) && c.marketing.minImagesPerPost >= 1 && c.marketing.minImagesPerPost <= 6, 'Invalid marketing.minImagesPerPost (1-6 images per post)');
  assert(c.marketing.minScore === 0 || c.marketing.minScore <= 6 || c.marketing.reviseAttempts > 0 || c.marketing.lowScoreAction === 'hold', 'minScore above 6 without a revision pass sends weak posts anyway; set reviseAttempts>0 or lowScoreAction=hold');
  assert(/^\/webhooks\/[a-z0-9/-]+$/.test(c.webhookPath), 'Invalid webhookPath');
  const u = new URL(c.publicWebhookUrl);
  assert(u.protocol === 'https:' && u.pathname === c.webhookPath && !u.search && !u.username && !u.password, 'Set HTTPS publicWebhookUrl matching webhookPath');
  assert(Number.isInteger(c.adminPort) && c.adminPort > 1024 && c.adminPort < 65536, 'Invalid adminPort');
  c.edgePort ??= 18892;
  assert(Number.isInteger(c.edgePort) && c.edgePort > 1024 && c.edgePort < 65536, 'Invalid edgePort');
  assert(c.edgePort !== c.adminPort, 'edgePort must differ from adminPort');
  c.orderTelegramChatIds ??= [];
  c.adminTelegramAllowedUsers ??= [];
  assert(Array.isArray(c.orderTelegramChatIds) && c.orderTelegramChatIds.every(x => typeof x === 'string' && x.trim()), 'Invalid orderTelegramChatIds');
  assert(Array.isArray(c.adminTelegramAllowedUsers) && c.adminTelegramAllowedUsers.every(x => typeof x === 'string' && x.trim()), 'Invalid adminTelegramAllowedUsers');
  for (const k of ['maxDailyAgentCalls','maxCustomerCallsPerHour','agentTimeoutMs']) assert(Number.isInteger(c[k]) && c[k] > 0, `Invalid ${k}`);
  assert(Number.isInteger(c.waitingResetSeconds) && c.waitingResetSeconds >= 0, 'Invalid waitingResetSeconds');
  assert(Number.isInteger(c.humanIdleResetSeconds) && c.humanIdleResetSeconds >= 0 && c.humanIdleResetSeconds <= 86400, 'Invalid humanIdleResetSeconds');
  assert(Number.isInteger(c.sessionTtlSeconds) && c.sessionTtlSeconds >= 0 && c.sessionTtlSeconds <= 604800, 'Invalid sessionTtlSeconds');
  assert(Number.isInteger(c.messageDebounceSeconds) && c.messageDebounceSeconds >= 0 && c.messageDebounceSeconds <= 60, 'Invalid messageDebounceSeconds');
  assert(typeof c.enableHumanHandoff === 'boolean', 'Invalid enableHumanHandoff');
  assert(c.agentTimeoutMs <= 120000, 'agentTimeoutMs must be <= 120000');
  assert(Array.isArray(c.scopeKeywords) && c.scopeKeywords.length && c.scopeKeywords.every(x => typeof x === 'string' && x.trim()), 'scopeKeywords required');
  for (const k of ['pageName','scopeDescription','handoffText','outOfScopeText','clarifyText']) assert(typeof c[k] === 'string' && c[k].trim().length > 0 && c[k].length <= 3000, `Invalid ${k}`);
  c.imageDir ??= './images';
  c.imageCatalogFile ??= './images/catalog.json';
  for (const k of ['envFile','database','workspace','knowledgeFile','imageDir','imageCatalogFile']) {
    assert(typeof c[k] === 'string' && c[k], `${k} required`);
    c[k] = resolve(dirname(resolve(file)), c[k]);
  }
  if (c.hermesHome != null) {
    assert(typeof c.hermesHome === 'string' && c.hermesHome.trim(), 'Invalid hermesHome');
    c.hermesHome = resolve(dirname(resolve(file)), c.hermesHome);
  }
  assert(!within(c.workspace, c.envFile) && !within(c.workspace, c.database), 'Secrets/database must be outside agent workspace');
  return c;
}

function parseBool(value, name) {
  if (['true','1','yes','on'].includes(value)) return true;
  if (['false','0','no','off'].includes(value)) return false;
  throw new Error(`${name} must be true/false`);
}

function envText(env, name, fallback) {
  const value = env[name] ?? fallback;
  assert(typeof value === 'string' && value.trim(), `${name} required`);
  return value.trim();
}
function envOptionalText(env, name, fallback) {
  const value = env[name] ?? fallback;
  return typeof value === 'string' ? value.trim() : value;
}
function envInt(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  assert(Number.isInteger(value), `${name} must be an integer`);
  return value;
}
function envCsv(env, name, fallback) {
  const raw = env[name] ?? fallback;
  const values = String(raw).split(',').map(x => x.trim()).filter(Boolean);
  assert(values.length > 0, `${name} must contain at least one value`);
  return values;
}
function envCsvOptional(env, name, fallback = '') {
  const raw = env[name] ?? fallback;
  return String(raw).split(',').map(x => x.trim()).filter(Boolean);
}
function envJsonArray(env, name, fallback = '[]') {
  const raw = env[name] ?? fallback;
  let values;
  try { values = JSON.parse(String(raw)); }
  catch { throw new Error(`${name} must be a JSON array`); }
  assert(Array.isArray(values), `${name} must be a JSON array`);
  return values.map(x => String(x).trim()).filter(Boolean);
}
function marketingConfigFromEnv(env) {
  return {
    enabled: parseBool(envText(env, 'PAGE_CSKH_ENABLE_MARKETING_POSTS', 'false').toLowerCase(), 'PAGE_CSKH_ENABLE_MARKETING_POSTS'),
    approvalRequired: parseBool(envText(env, 'PAGE_CSKH_MARKETING_APPROVAL_REQUIRED', 'true').toLowerCase(), 'PAGE_CSKH_MARKETING_APPROVAL_REQUIRED'),
    maxPostsPerDay: envInt(env, 'PAGE_CSKH_MARKETING_MAX_POSTS_PER_DAY', 3),
    defaultTone: envText(env, 'PAGE_CSKH_MARKETING_DEFAULT_TONE', 'thân thiện, chuyên nghiệp, ngắn gọn'),
    timezone: envText(env, 'PAGE_CSKH_MARKETING_TIMEZONE', 'Asia/Ho_Chi_Minh'),
    quietHours: envText(env, 'PAGE_CSKH_MARKETING_QUIET_HOURS', '22:00-07:00'),
    minScore: envInt(env, 'PAGE_CSKH_MARKETING_MIN_SCORE', 0),
    reviseAttempts: envInt(env, 'PAGE_CSKH_MARKETING_REVISE_ATTEMPTS', 1),
    lowScoreAction: envText(env, 'PAGE_CSKH_MARKETING_LOW_SCORE_ACTION', 'warn'),
    minImagesPerPost: envInt(env, 'PAGE_CSKH_MARKETING_MIN_IMAGES', 3)
  };
}

export function runtimeConfigFromEnv(env) {
  const pageId = envText(env, 'PAGE_CSKH_PAGE_ID');
  const webhookPath = envText(env, 'PAGE_CSKH_WEBHOOK_PATH', '/webhooks/page-cskh');
  const mode = envText(env, 'PAGE_CSKH_MODE', 'draft');
  assert(['draft','live'].includes(mode), 'PAGE_CSKH_MODE must be draft or live');
  const graphVersion = envText(env, 'PAGE_CSKH_GRAPH_VERSION', 'v25.0');
  const enableHumanHandoff = parseBool(envText(env, 'PAGE_CSKH_ENABLE_HUMAN_HANDOFF', 'true').toLowerCase(), 'PAGE_CSKH_ENABLE_HUMAN_HANDOFF');
  const database = envOptionalText(env, 'PAGE_CSKH_DATABASE', `./data/page-${pageId}.sqlite`);
  return {
    schemaVersion: 1,
    pageId,
    appId: envText(env, 'PAGE_CSKH_APP_ID'),
    pageName: envText(env, 'PAGE_CSKH_PAGE_NAME'),
    agentId: envText(env, 'PAGE_CSKH_AGENT_ID', 'page-cskh'),
    model: envText(env, 'PAGE_CSKH_MODEL'),
    graphVersion,
    envFile: envOptionalText(env, 'PAGE_CSKH_ENV_FILE', './.env'),
    database,
    workspace: envOptionalText(env, 'PAGE_CSKH_WORKSPACE', './agent'),
    hermesHome: envOptionalText(env, 'PAGE_CSKH_HERMES_HOME', undefined),
    knowledgeFile: envOptionalText(env, 'PAGE_CSKH_KNOWLEDGE_FILE', './knowledge.json'),
    imageDir: envOptionalText(env, 'PAGE_CSKH_IMAGE_DIR', './images'),
    imageCatalogFile: envOptionalText(env, 'PAGE_CSKH_IMAGE_CATALOG_FILE', './images/catalog.json'),
    webhookPath,
    publicWebhookUrl: envText(env, 'PAGE_CSKH_PUBLIC_WEBHOOK_URL'),
    adminPort: envInt(env, 'PAGE_CSKH_ADMIN_PORT', 18891),
    edgePort: envInt(env, 'PAGE_CSKH_EDGE_PORT', 18892),
    orderTelegramChatIds: envJsonArray(env, 'PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS', '[]'),
    adminTelegramAllowedUsers: envCsvOptional(env, 'PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS', ''),
    mode,
    waitingResetSeconds: envInt(env, 'PAGE_CSKH_WAITING_RESET_SECONDS', 0),
    sessionTtlSeconds: envInt(env, 'PAGE_CSKH_SESSION_TTL_SECONDS', 21600),
    messageDebounceSeconds: envInt(env, 'PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS', 2),
    humanIdleResetSeconds: envInt(env, 'PAGE_CSKH_HUMAN_IDLE_RESET_SECONDS', 300),
    enableHumanHandoff,
    scopeDescription: envText(env, 'PAGE_CSKH_SCOPE_DESCRIPTION', 'Chỉ tư vấn dịch vụ, sản phẩm và chính sách của Page này.'),
    scopeKeywords: envCsv(env, 'PAGE_CSKH_SCOPE_KEYWORDS', 'đặt hàng,giá,sản phẩm,chính sách'),
    handoffText: envText(env, 'PAGE_CSKH_HANDOFF_TEXT', 'Em chuyển nhân viên hỗ trợ tiếp nhé.'),
    outOfScopeText: envText(env, 'PAGE_CSKH_OUT_OF_SCOPE_TEXT', 'Em chỉ hỗ trợ thông tin dịch vụ và sản phẩm của Page này ạ.'),
    clarifyText: envText(env, 'PAGE_CSKH_CLARIFY_TEXT', 'Anh/chị muốn tìm hiểu sản phẩm hoặc dịch vụ nào của bên em ạ?'),
    maxDailyAgentCalls: envInt(env, 'PAGE_CSKH_MAX_DAILY_AGENT_CALLS', 200),
    maxCustomerCallsPerHour: envInt(env, 'PAGE_CSKH_MAX_CUSTOMER_CALLS_PER_HOUR', 20),
    agentTimeoutMs: envInt(env, 'PAGE_CSKH_AGENT_TIMEOUT_MS', 45000),
    marketing: marketingConfigFromEnv(env)
  };
}

export function applyEnvOverrides(config, env) {
  const c = {...config};
  if (env.PAGE_CSKH_MODE) {
    assert(['draft','live'].includes(env.PAGE_CSKH_MODE), 'PAGE_CSKH_MODE must be draft or live');
    c.mode = env.PAGE_CSKH_MODE;
  }
  if (env.PAGE_CSKH_WAITING_RESET_SECONDS) {
    const n = Number(env.PAGE_CSKH_WAITING_RESET_SECONDS);
    assert(Number.isInteger(n) && n >= 0, 'PAGE_CSKH_WAITING_RESET_SECONDS must be an integer >= 0');
    c.waitingResetSeconds = n;
  }
  if (env.PAGE_CSKH_HUMAN_IDLE_RESET_SECONDS) {
    const n = Number(env.PAGE_CSKH_HUMAN_IDLE_RESET_SECONDS);
    assert(Number.isInteger(n) && n >= 0 && n <= 86400, 'PAGE_CSKH_HUMAN_IDLE_RESET_SECONDS must be an integer from 0..86400');
    c.humanIdleResetSeconds = n;
  }
  if (env.PAGE_CSKH_SESSION_TTL_SECONDS) {
    const n = Number(env.PAGE_CSKH_SESSION_TTL_SECONDS);
    assert(Number.isInteger(n) && n >= 0 && n <= 604800, 'PAGE_CSKH_SESSION_TTL_SECONDS must be an integer from 0..604800');
    c.sessionTtlSeconds = n;
  }
  if (env.PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS) {
    const n = Number(env.PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS);
    assert(Number.isInteger(n) && n >= 0 && n <= 60, 'PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS must be an integer from 0..60');
    c.messageDebounceSeconds = n;
  }
  if (env.PAGE_CSKH_ENABLE_HUMAN_HANDOFF) {
    c.enableHumanHandoff = parseBool(env.PAGE_CSKH_ENABLE_HUMAN_HANDOFF.toLowerCase(), 'PAGE_CSKH_ENABLE_HUMAN_HANDOFF');
  }
  if (env.PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS) {
    c.orderTelegramChatIds = envJsonArray(env, 'PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS');
  }
  if (env.PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS) {
    c.adminTelegramAllowedUsers = envCsvOptional(env, 'PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS');
  }
  if (env.PAGE_CSKH_ENABLE_MARKETING_POSTS || env.PAGE_CSKH_MARKETING_APPROVAL_REQUIRED || env.PAGE_CSKH_MARKETING_MAX_POSTS_PER_DAY || env.PAGE_CSKH_MARKETING_DEFAULT_TONE || env.PAGE_CSKH_MARKETING_TIMEZONE || env.PAGE_CSKH_MARKETING_QUIET_HOURS || env.PAGE_CSKH_MARKETING_MIN_IMAGES) {
    c.marketing = {...(c.marketing ?? {}), ...marketingConfigFromEnv({...{
      PAGE_CSKH_ENABLE_MARKETING_POSTS: String(c.marketing?.enabled ?? false),
      PAGE_CSKH_MARKETING_APPROVAL_REQUIRED: String(c.marketing?.approvalRequired ?? true),
      PAGE_CSKH_MARKETING_MAX_POSTS_PER_DAY: String(c.marketing?.maxPostsPerDay ?? 3),
      PAGE_CSKH_MARKETING_DEFAULT_TONE: c.marketing?.defaultTone ?? 'thân thiện, chuyên nghiệp, ngắn gọn',
      PAGE_CSKH_MARKETING_TIMEZONE: c.marketing?.timezone ?? 'Asia/Ho_Chi_Minh',
      PAGE_CSKH_MARKETING_QUIET_HOURS: c.marketing?.quietHours ?? '22:00-07:00',
      PAGE_CSKH_MARKETING_MIN_IMAGES: String(c.marketing?.minImagesPerPost ?? 3)
    }, ...env})};
    assert(c.marketing.approvalRequired === true, 'marketing approval is required');
  }
  return c;
}

export function loadSecrets(file, workspace) {
  const st = statSync(file);
  assert(st.isFile() && st.size < 32768, 'Invalid env file');
  if (process.platform !== 'win32') assert((st.mode & 0o077) === 0, 'env file must have mode 600');
  if (workspace) assert(!within(realpathSync(workspace), realpathSync(file)), 'env must not resolve inside agent workspace');
  const env = parseEnv(readFileSync(file,'utf8'));
  for (const k of ['META_APP_SECRET','META_WEBHOOK_VERIFY_TOKEN','META_PAGE_ACCESS_TOKEN','CSKH_ADMIN_TOKEN']) assert(typeof env[k] === 'string' && env[k].length >= 16, `Missing/short ${k}`);
  assert(env.CSKH_ADMIN_TOKEN.length >= 32, 'CSKH_ADMIN_TOKEN needs >=32 characters');
  return Object.freeze(env);
}
