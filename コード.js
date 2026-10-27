/**
 * 個人カレンダーの予定を、同期先カレンダーに「予定あり」として同期する。
 * Calendar API (高度なサービス) を使い、一覧取得をまとめて行う。
 *
 * 設定はスクリプトプロパティから読み込む。
 * GAS エディタ: プロジェクトの設定 > スクリプト プロパティ
 *   GUEST_EMAIL      : 同期した「予定あり」の招待先メールアドレス
 *   SYNC_CALENDAR_ID : 同期先カレンダーの ID (xxx@group.calendar.google.com)
 */
const PROPS = PropertiesService.getScriptProperties();
const B_EMAIL = getRequiredProperty_('GUEST_EMAIL');
const SYNC_CALENDAR_ID = getRequiredProperty_('SYNC_CALENDAR_ID');

const SOURCE_CALENDAR_ID = 'primary';
const SYNC_DAYS = 180;
const SYNC_PREFIX = '[BUSY_SYNC:';
const SYNC_TITLE = '予定あり';
const KEY_PROPERTY = 'busySyncKey';


function syncBusyToCompany() {
  // 同時実行 (トリガー + 手動実行など) で二重作成されるのを防ぐ
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30 * 1000)) {
    console.log('別の同期が実行中のためスキップ');
    return;
  }

  try {
    syncBusyToCompany_();
  } finally {
    lock.releaseLock();
  }
}


function syncBusyToCompany_() {
  const started = Date.now();

  // 今日の 0 時から SYNC_DAYS 日後まで
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + SYNC_DAYS);

  const sourceEvents = listEvents_(SOURCE_CALENDAR_ID, start, end)
    .filter(isBusyEvent_);

  const syncedEvents = listEvents_(SYNC_CALENDAR_ID, start, end);

  // 同期予定を key ごとに管理。同じ key が複数あれば 1 つだけ残して削除する
  const syncedMap = new Map();
  const stats = { created: 0, updated: 0, duplicates: 0, removed: 0, errors: 0 };

  syncedEvents.forEach(event => {
    const key = getSyncKey_(event);

    if (!key) {
      return;
    }

    if (syncedMap.has(key)) {
      deleteSyncEvent_(event, stats);
      stats.duplicates++;
      return;
    }

    syncedMap.set(key, event);
  });

  // 今回必要な同期予定キー
  const desiredKeys = new Set();

  sourceEvents.forEach(source => {
    try {
      if (isAllDay_(source)) {
        syncAllDayEvent_(source, syncedMap, desiredKeys, stats);
      } else {
        syncTimedEvent_(source, syncedMap, desiredKeys, stats);
      }
    } catch (e) {
      stats.errors++;
      console.error(`同期失敗 source=${source.id}: ${e}`);
    }
  });

  // 不要になった同期予定を削除
  syncedMap.forEach((syncEvent, key) => {
    if (!desiredKeys.has(key)) {
      deleteSyncEvent_(syncEvent, stats);
      stats.removed++;
    }
  });

  console.log(
    `source=${sourceEvents.length} synced=${syncedEvents.length} ` +
    `created=${stats.created} updated=${stats.updated} ` +
    `duplicates=${stats.duplicates} removed=${stats.removed} ` +
    `errors=${stats.errors} time=${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}


// ---------------------------------------------------------------------------
// 一覧取得
// ---------------------------------------------------------------------------

/**
 * 期間内の予定を全ページ取得する。
 * singleEvents: true で繰り返し予定は各回に展開される。
 */
function listEvents_(calendarId, start, end) {
  const events = [];
  let pageToken = null;

  do {
    const res = Calendar.Events.list(calendarId, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken
    });

    (res.items || []).forEach(item => {
      if (item.status !== 'cancelled') {
        events.push(item);
      }
    });

    pageToken = res.nextPageToken;
  } while (pageToken);

  return events;
}


/**
 * 「予定あり」として同期すべき予定か。
 * 予定なし扱い (transparent)、自分が辞退した予定、勤務場所は除外する。
 */
function isBusyEvent_(event) {
  if (event.transparency === 'transparent') {
    return false;
  }

  if (event.eventType === 'workingLocation') {
    return false;
  }

  const self = (event.attendees || []).find(a => a.self);

  if (self && self.responseStatus === 'declined') {
    return false;
  }

  return true;
}


// ---------------------------------------------------------------------------
// キー
// ---------------------------------------------------------------------------

/**
 * 元予定を一意に識別するキー。
 * CalendarApp 版と同じ形式にして、既存の同期予定をそのまま引き継ぐ。
 *   単発:     <iCalUID>
 *   繰り返し: <iCalUID>@<開始時刻ms>
 */
function getSourceKey_(source) {
  let key = source.iCalUID || source.id;

  if (source.recurringEventId) {
    key += '@' + getStartDate_(source).getTime();
  }

  return key;
}


/**
 * 同期予定からキーを取り出す。
 * 拡張プロパティを優先し、無ければ説明欄の [BUSY_SYNC:...] を見る (旧形式)。
 */
function getSyncKey_(event) {
  const props = event.extendedProperties && event.extendedProperties.private;

  if (props && props[KEY_PROPERTY]) {
    return props[KEY_PROPERTY];
  }

  const description = event.description || '';
  const match = description.match(/\[BUSY_SYNC:([^\]]+)\]/);

  return match ? match[1] : null;
}


// ---------------------------------------------------------------------------
// 同期
// ---------------------------------------------------------------------------

function syncTimedEvent_(source, syncedMap, desiredKeys, stats) {
  const key = getSourceKey_(source) + ':timed';

  desiredKeys.add(key);

  const existing = syncedMap.get(key);

  if (!existing) {
    insertSyncEvent_({
      summary: SYNC_TITLE,
      start: { dateTime: source.start.dateTime },
      end: { dateTime: source.end.dateTime }
    }, key);
    stats.created++;
    return;
  }

  // もしなぜか終日予定になっていたら作り直し
  if (isAllDay_(existing)) {
    deleteSyncEvent_(existing, stats);
    insertSyncEvent_({
      summary: SYNC_TITLE,
      start: { dateTime: source.start.dateTime },
      end: { dateTime: source.end.dateTime }
    }, key);
    stats.created++;
    return;
  }

  const oldStart = Date.parse(existing.start.dateTime);
  const oldEnd = Date.parse(existing.end.dateTime);
  const newStart = Date.parse(source.start.dateTime);
  const newEnd = Date.parse(source.end.dateTime);

  if (oldStart !== newStart || oldEnd !== newEnd) {
    Calendar.Events.patch(
      {
        start: { dateTime: source.start.dateTime },
        end: { dateTime: source.end.dateTime }
      },
      SYNC_CALENDAR_ID,
      existing.id,
      { sendUpdates: 'all' }
    );
    stats.updated++;
  }
}


function syncAllDayEvent_(source, syncedMap, desiredKeys, stats) {
  const sourceKey = getSourceKey_(source);
  const endDate = parseDateOnly_(source.end.date);

  // end.date は「終了翌日」なので、start から end 未満まで 1 日ずつ作成する
  const current = parseDateOnly_(source.start.date);

  while (current < endDate) {
    const dateKey = formatDateKey_(current);
    const key = sourceKey + ':allday:' + dateKey;

    desiredKeys.add(key);

    const existing = syncedMap.get(key);

    if (!existing) {
      insertSingleDaySyncEvent_(current, key);
      stats.created++;
    } else if (!isAllDay_(existing)) {
      // もし通常予定になっていたら作り直す
      deleteSyncEvent_(existing, stats);
      insertSingleDaySyncEvent_(current, key);
      stats.created++;
    }

    current.setDate(current.getDate() + 1);
  }
}


function insertSingleDaySyncEvent_(date, key) {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);

  insertSyncEvent_({
    summary: SYNC_TITLE,
    start: { date: formatDateKey_(date) },
    end: { date: formatDateKey_(next) }
  }, key);
}


function insertSyncEvent_(resource, key) {
  resource.description = SYNC_PREFIX + key + ']';
  resource.visibility = 'private';
  resource.attendees = [{ email: B_EMAIL }];
  resource.extendedProperties = { private: { [KEY_PROPERTY]: key } };

  Calendar.Events.insert(resource, SYNC_CALENDAR_ID, { sendUpdates: 'all' });
}


function deleteSyncEvent_(event, stats) {
  try {
    Calendar.Events.remove(SYNC_CALENDAR_ID, event.id, { sendUpdates: 'all' });
  } catch (e) {
    // 既に消えている (410 Gone など) 場合は無視
    if (!/410|deleted|not found/i.test(String(e))) {
      stats.errors++;
      console.error(`削除失敗 ${event.id}: ${e}`);
    }
  }
}


// ---------------------------------------------------------------------------
// 日付ユーティリティ
// ---------------------------------------------------------------------------

function isAllDay_(event) {
  return !!(event.start && event.start.date);
}


function getStartDate_(event) {
  return isAllDay_(event)
    ? parseDateOnly_(event.start.date)
    : new Date(event.start.dateTime);
}


/** 'yyyy-MM-dd' をスクリプトのタイムゾーンの 0 時として返す */
function parseDateOnly_(text) {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d);
}


function formatDateKey_(date) {
  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'yyyy-MM-dd'
  );
}


function getRequiredProperty_(key) {
  const value = PROPS.getProperty(key);

  if (!value) {
    throw new Error(
      'スクリプトプロパティ ' + key + ' が設定されていません'
    );
  }

  return value;
}
