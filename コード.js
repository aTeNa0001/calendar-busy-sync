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


function syncBusyToCompany() {
  const sourceCalendar = CalendarApp.getDefaultCalendar();
  const syncCalendar = CalendarApp.getCalendarById(SYNC_CALENDAR_ID);

  if (!syncCalendar) {
    throw new Error('同期用カレンダーを取得できません');
  }

  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + SYNC_DAYS);

  // Aメインの予定
  const sourceEvents = sourceCalendar.getEvents(start, end);

  // 同期用カレンダーの既存予定
  const syncedEvents = syncCalendar.getEvents(start, end);

  // 同期予定を key ごとに管理
  const syncedMap = new Map();

  syncedEvents.forEach(event => {
    const key = getSyncKey(event);

    if (key) {
      syncedMap.set(key, event);
    }
  });

  // 今回必要な同期予定キー
  const desiredKeys = new Set();

  sourceEvents.forEach(source => {
    const sourceId = source.getId();

    if (source.isAllDayEvent()) {
      syncAllDayEvent(
        syncCalendar,
        source,
        sourceId,
        syncedMap,
        desiredKeys
      );
    } else {
      syncTimedEvent(
        syncCalendar,
        source,
        sourceId,
        syncedMap,
        desiredKeys
      );
    }
  });

  // 不要になった同期予定を削除
  syncedEvents.forEach(syncEvent => {
    const key = getSyncKey(syncEvent);

    if (
      key &&
      !desiredKeys.has(key)
    ) {
      syncEvent.deleteEvent();
    }
  });
}


function syncTimedEvent(
  syncCalendar,
  source,
  sourceId,
  syncedMap,
  desiredKeys
) {
  const key = sourceId + ':timed';

  desiredKeys.add(key);

  const existing = syncedMap.get(key);

  if (!existing) {
    createTimedSyncEvent(
      syncCalendar,
      source,
      key
    );
    return;
  }

  // もしなぜか終日予定になっていたら作り直し
  if (existing.isAllDayEvent()) {
    existing.deleteEvent();

    createTimedSyncEvent(
      syncCalendar,
      source,
      key
    );

    return;
  }

  const oldStart =
    existing.getStartTime().getTime();

  const oldEnd =
    existing.getEndTime().getTime();

  const newStart =
    source.getStartTime().getTime();

  const newEnd =
    source.getEndTime().getTime();

  if (
    oldStart !== newStart ||
    oldEnd !== newEnd
  ) {
    existing.setTime(
      source.getStartTime(),
      source.getEndTime()
    );
  }
}


function createTimedSyncEvent(
  syncCalendar,
  source,
  key
) {
  const event = syncCalendar.createEvent(
    '予定あり',
    source.getStartTime(),
    source.getEndTime(),
    {
      description:
        SYNC_PREFIX + key + ']',

      guests: B_EMAIL,
      sendInvites: true
    }
  );

  event.setVisibility(
    CalendarApp.Visibility.PRIVATE
  );
}


function syncAllDayEvent(
  syncCalendar,
  source,
  sourceId,
  syncedMap,
  desiredKeys
) {
  const startDate =
    source.getAllDayStartDate();

  const endDate =
    source.getAllDayEndDate();

  // endDate は「翌日の0時」なので、
  // start から end 未満まで1日ずつ作成する
  const current = new Date(startDate);

  while (current < endDate) {

    const dateKey = formatDateKey(current);

    const key =
      sourceId + ':allday:' + dateKey;

    desiredKeys.add(key);

    const existing = syncedMap.get(key);

    if (!existing) {
      createSingleDaySyncEvent(
        syncCalendar,
        current,
        key
      );
    } else {

      // もし通常予定になっていたら作り直す
      if (!existing.isAllDayEvent()) {
        existing.deleteEvent();

        createSingleDaySyncEvent(
          syncCalendar,
          current,
          key
        );
      }
    }

    current.setDate(
      current.getDate() + 1
    );
  }
}


function createSingleDaySyncEvent(
  syncCalendar,
  date,
  key
) {
  const event = syncCalendar.createAllDayEvent(
    '予定あり',
    new Date(date),
    {
      description:
        SYNC_PREFIX + key + ']',

      guests: B_EMAIL,
      sendInvites: true
    }
  );

  event.setVisibility(
    CalendarApp.Visibility.PRIVATE
  );
}


function getSyncKey(event) {
  const description =
    event.getDescription();

  const match = description.match(
    /^\[BUSY_SYNC:(.+)\]$/
  );

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
