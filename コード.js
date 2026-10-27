/**
 * 設定はスクリプトプロパティから読み込む。
 * GAS エディタ: プロジェクトの設定 > スクリプト プロパティ
 *   GUEST_EMAIL      : 同期した「予定あり」の招待先メールアドレス
 *   SYNC_CALENDAR_ID : 同期先カレンダーの ID (xxx@group.calendar.google.com)
 */
const PROPS = PropertiesService.getScriptProperties();
const B_EMAIL = getRequiredProperty_('GUEST_EMAIL');
const SYNC_CALENDAR_ID = getRequiredProperty_('SYNC_CALENDAR_ID');

const SYNC_DAYS = 180;
const SYNC_PREFIX = '[BUSY_SYNC:';
const SYNC_TITLE = '予定あり';


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
  const sourceCalendar = CalendarApp.getDefaultCalendar();
  const syncCalendar = CalendarApp.getCalendarById(SYNC_CALENDAR_ID);

  if (!syncCalendar) {
    throw new Error('同期用カレンダーを取得できません');
  }

  // 今日の 0 時から SYNC_DAYS 日後まで
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + SYNC_DAYS);

  const sourceEvents = sourceCalendar.getEvents(start, end);
  const syncedEvents = syncCalendar.getEvents(start, end);

  // 同期予定を key ごとに管理。同じ key が複数あれば 1 つだけ残して削除する
  const syncedMap = new Map();
  let duplicates = 0;

  syncedEvents.forEach(event => {
    const key = getSyncKey(event);

    if (!key) {
      return;
    }

    if (syncedMap.has(key)) {
      event.deleteEvent();
      duplicates++;
      return;
    }

    syncedMap.set(key, event);
  });

  // 今回必要な同期予定キー
  const desiredKeys = new Set();

  sourceEvents.forEach(source => {
    const sourceKey = getSourceKey_(source);

    if (source.isAllDayEvent()) {
      syncAllDayEvent(
        syncCalendar,
        source,
        sourceKey,
        syncedMap,
        desiredKeys
      );
    } else {
      syncTimedEvent(
        syncCalendar,
        source,
        sourceKey,
        syncedMap,
        desiredKeys
      );
    }
  });

  // 不要になった同期予定を削除
  let removed = 0;

  syncedMap.forEach((syncEvent, key) => {
    if (!desiredKeys.has(key)) {
      syncEvent.deleteEvent();
      removed++;
    }
  });

  console.log(
    `source=${sourceEvents.length} synced=${syncedEvents.length} ` +
    `duplicates=${duplicates} removed=${removed}`
  );
}


/**
 * 元予定を一意に識別するキー。
 * 繰り返し予定は全ての回が同じ iCalUID を返すため、開始時刻を付けて区別する。
 */
function getSourceKey_(source) {
  let key = source.getId();

  if (source.isRecurringEvent()) {
    key += '@' + source.getStartTime().getTime();
  }

  return key;
}


function syncTimedEvent(
  syncCalendar,
  source,
  sourceKey,
  syncedMap,
  desiredKeys
) {
  const key = sourceKey + ':timed';

  desiredKeys.add(key);

  const existing = syncedMap.get(key);

  if (!existing) {
    createTimedSyncEvent(syncCalendar, source, key);
    return;
  }

  // もしなぜか終日予定になっていたら作り直し
  if (existing.isAllDayEvent()) {
    existing.deleteEvent();
    createTimedSyncEvent(syncCalendar, source, key);
    return;
  }

  const oldStart = existing.getStartTime().getTime();
  const oldEnd = existing.getEndTime().getTime();
  const newStart = source.getStartTime().getTime();
  const newEnd = source.getEndTime().getTime();

  if (oldStart !== newStart || oldEnd !== newEnd) {
    existing.setTime(source.getStartTime(), source.getEndTime());
  }
}


function createTimedSyncEvent(syncCalendar, source, key) {
  const event = syncCalendar.createEvent(
    SYNC_TITLE,
    source.getStartTime(),
    source.getEndTime(),
    {
      description: SYNC_PREFIX + key + ']',
      guests: B_EMAIL,
      sendInvites: true
    }
  );

  event.setVisibility(CalendarApp.Visibility.PRIVATE);
}


function syncAllDayEvent(
  syncCalendar,
  source,
  sourceKey,
  syncedMap,
  desiredKeys
) {
  const startDate = source.getAllDayStartDate();
  const endDate = source.getAllDayEndDate();

  // endDate は「翌日の0時」なので、start から end 未満まで1日ずつ作成する
  const current = new Date(startDate);

  while (current < endDate) {
    const dateKey = formatDateKey(current);
    const key = sourceKey + ':allday:' + dateKey;

    desiredKeys.add(key);

    const existing = syncedMap.get(key);

    if (!existing) {
      createSingleDaySyncEvent(syncCalendar, current, key);
    } else if (!existing.isAllDayEvent()) {
      // もし通常予定になっていたら作り直す
      existing.deleteEvent();
      createSingleDaySyncEvent(syncCalendar, current, key);
    }

    current.setDate(current.getDate() + 1);
  }
}


function createSingleDaySyncEvent(syncCalendar, date, key) {
  const event = syncCalendar.createAllDayEvent(
    SYNC_TITLE,
    new Date(date),
    {
      description: SYNC_PREFIX + key + ']',
      guests: B_EMAIL,
      sendInvites: true
    }
  );

  event.setVisibility(CalendarApp.Visibility.PRIVATE);
}


/**
 * 同期予定の説明欄からキーを取り出す。
 * 説明欄が HTML 化されたり前後に空白が付いても拾えるよう、部分一致で探す。
 */
function getSyncKey(event) {
  const description = event.getDescription() || '';
  const match = description.match(/\[BUSY_SYNC:([^\]]+)\]/);

  return match ? match[1] : null;
}


function formatDateKey(date) {
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
