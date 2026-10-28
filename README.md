# calendar-busy-sync

個人の Google カレンダーの予定を、別カレンダーに「予定あり」として同期する Google Apps Script。
予定のタイトルや内容は渡さず、時間枠だけを共有する。

## 動作

- 既定カレンダーの今日から `SYNC_DAYS` 日先までの予定を取得
- 同期先カレンダーに「予定あり」イベントを作成し、指定メールアドレスを招待
- 終日予定は 1 日ごとに 9:00〜18:00 の「予定あり」として同期 (`ALLDAY_BUSY_START_HOUR` / `ALLDAY_BUSY_END_HOUR`)
- 辞退した予定、勤務場所、「予定なし」扱いの時間指定予定は同期しない
- 元の予定が消えたり時間が変わったら同期先も追従
- 同期イベントは説明欄の `[BUSY_SYNC:...]` キーで管理

## セットアップ

1. GAS エディタ「プロジェクトの設定 > スクリプト プロパティ」に以下を追加
   | キー | 値 |
   | --- | --- |
   | `GUEST_EMAIL` | 招待先メールアドレス |
   | `SYNC_CALENDAR_ID` | 同期先カレンダー ID (`xxx@group.calendar.google.com`) |
2. `syncBusyToCompany` を時間主導型トリガーで定期実行する

## 開発

```sh
npm install -g @google/clasp
clasp login
clasp clone <スクリプトID>   # .clasp.json が生成される (git 管理外)
clasp push                  # ローカル → GAS
clasp pull                  # GAS → ローカル
```
